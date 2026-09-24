"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, FileText, Info, Play, RefreshCcw, RotateCcw, Settings2, Square, Undo2, XCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, errorMessage, formatDate, formatRelative } from "../lib";
import { useNow } from "../panel-context";
import type { MinecraftServer, OperationEvent } from "../types";

const filters = [
  { key: "all", label: "All", match: () => true },
  { key: "problems", label: "Problems", match: (event: OperationEvent) => event.level === "error" || event.level === "warning" },
  { key: "backups", label: "Backups", match: (event: OperationEvent) => event.type.startsWith("backup") || event.type === "restore" },
  { key: "power", label: "Starts and restarts", match: (event: OperationEvent) => ["start", "stop", "restart", "status", "create", "remove"].includes(event.type) },
  { key: "changes", label: "Settings and files", match: (event: OperationEvent) => event.type === "settings" || event.type === "update" || event.type.startsWith("file") },
] as const;

const typeIcons = { backup: Archive, restore: Undo2, file: FileText, settings: Settings2, update: RefreshCcw, restart: RotateCcw, stop: Square, start: Play, other: Info } as const;

function typeKey(type: string): keyof typeof typeIcons {
  if (type.startsWith("backup")) return "backup";
  if (type.startsWith("file")) return "file";
  if (type === "remove") return "stop";
  if (type === "create") return "start";
  return type in typeIcons ? type as keyof typeof typeIcons : "other";
}

const levelIcons = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle } as const;
const levelLabels = { success: "Succeeded", info: "Info", warning: "Warning", error: "Error" } as const;

function EventRow({ event, now }: { event: OperationEvent; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const Type = typeIcons[typeKey(event.type)];
  const Level = levelIcons[event.level];
  const long = event.message.length > 160;
  return <li className="flex gap-3 py-3">
    <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border", event.level === "error" ? "border-destructive/30 bg-danger-soft text-destructive" : event.level === "warning" ? "border-warning/30 bg-warning-soft text-warning" : "border-border bg-muted text-muted-foreground")}><Type className="size-4" aria-hidden /></span>
    <div className="min-w-0 flex-1">
      <p className={cn("text-sm break-words", !expanded && long && "line-clamp-2")}>{event.message}</p>
      {long && <button type="button" className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Show less" : "Show full message"}</button>}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Level className={cn("size-3.5", event.level === "success" && "text-success", event.level === "error" && "text-destructive", event.level === "warning" && "text-warning")} aria-hidden />{levelLabels[event.level]}</span>
        <time dateTime={event.at} title={formatDate(event.at)}>{formatRelative(event.at, now)}</time>
        {event.actor && <span>by {event.actor}</span>}
      </p>
    </div>
  </li>;
}

export function ActivityTab({ server }: { server: MinecraftServer }) {
  const now = useNow(30_000);
  const [events, setEvents] = useState<OperationEvent[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]["key"]>("all");
  const load = useCallback(async () => {
    try { setEvents((await api<{ events: OperationEvent[] }>(`/api/servers/${server.id}/events`)).events); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Activity is unavailable.")); }
  }, [server.id]);
  const marker = `${server.lastOperation?.finishedAt}|${server.status}|${server.restartCount}`;
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, marker]);
  const matcher = filters.find((item) => item.key === filter)!.match;
  const visible = useMemo(() => (events || []).filter(matcher), [events, matcher]);
  return <div className="max-w-3xl">
    <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter activity">
      {filters.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} className={cn("rounded-full border px-3 py-1 text-xs", filter === item.key ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>{item.label}</button>)}
    </div>
    {error ? <p className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>
      : !events ? <Skeleton className="h-48" />
        : visible.length ? <ul className="divide-y divide-border rounded-xl border border-border bg-card px-4">{visible.map((event) => <EventRow key={event.id} event={event} now={now} />)}</ul>
          : <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{events.length ? "Nothing matches this filter." : "Nothing has happened on this server yet."}</div>}
    <p className="mt-3 text-xs text-muted-foreground">The latest 100 events are kept.</p>
  </div>;
}
