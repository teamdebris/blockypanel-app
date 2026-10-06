"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type Capabilities, capabilities, type Role } from "@/lib/roles";
import { api, errorMessage, storageGet, storageSet } from "./lib";
import type { DetachedWorld, MinecraftServer, SystemState } from "./types";

type MetricSample = { at: number; cpu: number; memory: number };
type ServerAction = "start" | "stop" | "restart" | "backup" | "update";
type Me = { username: string; role: Role; recovery: boolean; demo: boolean };

type PanelContextValue = {
  servers: MinecraftServer[];
  system: SystemState | null;
  worlds: DetachedWorld[];
  loaded: boolean;
  lastUpdatedAt: number | null;
  /** Consecutive failed polls; 2+ means the panel itself is unreachable (not Docker). */
  failures: number;
  refreshing: boolean;
  refresh: () => Promise<void>;
  history: Record<string, MetricSample[]>;
  pending: Set<string>;
  isPending: (key: string) => boolean;
  /** Runs `work` while `key` is marked pending, and refreshes afterwards. */
  track: <T>(key: string, work: () => Promise<T>) => Promise<T | undefined>;
  runAction: (server: MinecraftServer, action: ServerAction) => Promise<void>;
  /** The signed-in person; null until loaded. */
  me: Me | null;
  /** What `me`'s role may do. Everything is false until `me` loads. The server enforces it regardless. */
  can: Capabilities;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  dismissedResults: Set<string>;
  dismissResult: (finishedAt: string) => void;
  /** When each server was last seen in a server list, so a brief gap doesn't read as "deleted". */
  lastSeen: Record<string, number>;
  /** Adds a just-created server before the next poll includes it. */
  announceServer: (server: MinecraftServer) => void;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
};

const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel() {
  const value = useContext(PanelContext);
  if (!value) throw new Error("usePanel must be used inside PanelProvider.");
  return value;
}

const HISTORY_MS = 10 * 60_000;

function notifyBrowser(title: string, body: string) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
    new Notification(title, { body, icon: "/favicon.svg" });
  } catch { /* unsupported */ }
}

export function PanelProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<MinecraftServer[]>([]);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [worlds, setWorlds] = useState<DetachedWorld[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<Record<string, MetricSample[]>>({});
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [me, setMe] = useState<Me | null>(null);
  const canManage = useRef(false);
  const [notificationsEnabled, setNotificationsState] = useState(false);
  const [dismissedResults, setDismissed] = useState<Set<string>>(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const inFlight = useRef(false);
  const seenOperations = useRef<Map<string, string> | null>(null);
  const seenStatus = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const [nextSystem, nextServers, nextWorlds] = await Promise.all([
        api<SystemState>("/api/system"),
        api<{ servers: MinecraftServer[] }>("/api/servers").catch((error) => {
          // Docker being down is reported by /api/system; keep the last list rather than blanking it.
          if (error instanceof Error && "status" in error && (error as { status: number }).status >= 500) return null;
          throw error;
        }),
        // Detached worlds are admin-only.
        canManage.current ? api<{ worlds: DetachedWorld[] }>("/api/worlds").catch(() => null) : Promise.resolve(null),
      ]);
      setSystem(nextSystem);
      if (nextServers) {
        setServers(nextServers.servers);
        const now = Date.now();
        setLastSeen((current) => ({ ...current, ...Object.fromEntries(nextServers.servers.map((server) => [server.id, now])) }));
        setHistory((current) => {
          const next: Record<string, MetricSample[]> = {};
          for (const server of nextServers.servers) {
            const samples = (current[server.id] || []).filter((sample) => now - sample.at < HISTORY_MS);
            next[server.id] = [...samples, { at: now, cpu: server.cpuPercent, memory: server.memoryUsageMb }];
          }
          return next;
        });
      }
      if (nextWorlds) setWorlds(nextWorlds.worlds);
      setLastUpdatedAt(Date.now());
      setFailures(0);
      setLoaded(true);
    } catch {
      setFailures((count) => count + 1);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  // Polling: faster while background work runs, paused while the tab is hidden, immediate on return.
  const anyOperation = servers.some((server) => server.operation);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { window.clearTimeout(initial); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" && !notificationsEnabled) return;
      void refresh();
    }, anyOperation ? 2500 : document.visibilityState === "hidden" ? 30_000 : 8000);
    return () => window.clearInterval(timer);
  }, [refresh, anyOperation, notificationsEnabled]);

  // Announce background operations and crashes that happen while the panel is open. The first
  // server list is the baseline (results from before this page load aren't announced), so nothing
  // is recorded until it has loaded. Entries are kept for servers missing from one poll, so a
  // server that briefly drops out of the list isn't announced again when it returns.
  useEffect(() => {
    if (!loaded) return;
    const seen = seenOperations.current;
    const next = new Map(seen ?? []);
    for (const server of servers) if (server.lastOperation) next.set(server.id, server.lastOperation.finishedAt);
    seenOperations.current = next;
    for (const server of servers) {
      const previous = seenStatus.current.get(server.id);
      seenStatus.current.set(server.id, server.status);
      if (seen && previous && previous !== "failed" && server.status === "failed" && !server.operation) notifyBrowser(`${server.name} crashed`, server.statusMessage);
    }
    if (!seen) return;
    for (const server of servers) {
      const finished = server.lastOperation;
      if (!finished || seen.get(server.id) === finished.finishedAt) continue;
      if (finished.ok) toast.success(`${server.name}: ${finished.message}`);
      else toast.error(`${server.name}: ${finished.label} failed`, { description: finished.message, duration: 15000 });
      notifyBrowser(`${server.name}: ${finished.label} ${finished.ok ? "finished" : "failed"}`, finished.message);
    }
  }, [servers, loaded]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setNotificationsState(storageGet("blocky:notifications") === "on" && typeof Notification !== "undefined" && Notification.permission === "granted");
      try { setDismissed(new Set(JSON.parse(storageGet("blocky:dismissed") || "[]") as string[])); } catch { /* ignore */ }
    }, 0);
    api<Me>("/api/auth/me").then((next) => {
      setMe(next);
      canManage.current = capabilities(next.role).manage;
      if (canManage.current) void refresh();
    }).catch(() => undefined);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const track = useCallback(async <T,>(key: string, work: () => Promise<T>) => {
    setPending((current) => new Set(current).add(key));
    try { return await work(); }
    catch (error) { toast.error(errorMessage(error, "The request failed.")); return undefined; }
    finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next; });
      void refresh();
    }
  }, [refresh]);

  const runAction = useCallback(async (server: MinecraftServer, action: ServerAction) => {
    await track(`${server.id}:${action}`, async () => {
      const result = await api<{ message: string }>(`/api/servers/${server.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
      toast.success(result.message);
    });
  }, [track]);

  const setNotificationsEnabled = useCallback(async (enabled: boolean) => {
    if (enabled) {
      if (typeof Notification === "undefined") { toast.error("This browser doesn't support notifications."); return; }
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") { toast.error("Notifications are blocked for this site in your browser settings."); return; }
    }
    storageSet("blocky:notifications", enabled ? "on" : "off");
    setNotificationsState(enabled);
    toast.success(enabled ? "You'll be notified when operations finish or a server crashes while this tab is in the background." : "Browser notifications turned off.");
  }, []);

  const dismissResult = useCallback((finishedAt: string) => {
    setDismissed((current) => {
      const next = new Set(current).add(finishedAt);
      storageSet("blocky:dismissed", JSON.stringify([...next].slice(-50)));
      return next;
    });
  }, []);

  const announceServer = useCallback((server: MinecraftServer) => {
    setServers((current) => current.some((item) => item.id === server.id) ? current : [server, ...current]);
    setLastSeen((current) => ({ ...current, [server.id]: Date.now() }));
  }, []);

  const can = useMemo(() => capabilities(me?.role), [me]);
  const value = useMemo<PanelContextValue>(() => ({
    servers, system, worlds, loaded, lastUpdatedAt, failures, refreshing, refresh, history, pending,
    isPending: (key) => pending.has(key) || [...pending].some((item) => key.endsWith(":*") && item.startsWith(key.slice(0, -1))),
    track, runAction, me, can, notificationsEnabled, setNotificationsEnabled, dismissedResults, dismissResult,
    lastSeen, announceServer, createOpen, setCreateOpen, paletteOpen, setPaletteOpen,
  }), [lastSeen, announceServer, servers, system, worlds, loaded, lastUpdatedAt, failures, refreshing, refresh, history, pending, track, runAction, me, can, notificationsEnabled, setNotificationsEnabled, dismissedResults, dismissResult, createOpen, paletteOpen]);

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/** Re-renders every `ms` so relative times ("5s ago") stay current. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}
