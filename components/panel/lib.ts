import { CSRF_HEADER } from "@/lib/csrf";
import type { Backup, JavaVersion, MinecraftServer, ServerConfig, ServerForm, ServerTab, ServerType } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly field?: string) { super(message); }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1", ...init?.headers } });
  if (response.status === 401) {
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError("Authentication required.", 401);
  }
  const body = await response.json().catch(() => ({})) as { error?: string; field?: string };
  if (!response.ok) throw new ApiError(body.error || "The request failed.", response.status, body.field);
  return body as T;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export const serverTypes: { value: ServerType; label: string; description: string }[] = [
  { value: "PAPER", label: "Paper", description: "Fast, supports plugins. Recommended." },
  { value: "PURPUR", label: "Purpur", description: "Paper with extra gameplay options." },
  { value: "VANILLA", label: "Vanilla", description: "The official server, no plugins." },
  { value: "FABRIC", label: "Fabric", description: "Lightweight mods." },
  { value: "QUILT", label: "Quilt", description: "Fabric-compatible mods." },
  { value: "FORGE", label: "Forge", description: "Classic mod packs." },
  { value: "NEOFORGE", label: "NeoForge", description: "Modern Forge mods." },
];
export const moddedTypes = new Set<ServerType>(["FABRIC", "QUILT", "FORGE", "NEOFORGE"]);

export const javaVersions: { value: JavaVersion; label: string }[] = [
  { value: "auto", label: "Automatic (image default)" }, { value: "25", label: "Java 25" }, { value: "21", label: "Java 21" },
  { value: "17", label: "Java 17" }, { value: "11", label: "Java 11" }, { value: "8", label: "Java 8" },
];

export const memoryOptions = ["2G", "4G", "6G", "8G", "12G", "16G"];

export const tabLabels: Record<ServerTab, string> = { overview: "Overview", console: "Console", plugins: "Plugins", backups: "Backups", files: "Files", settings: "Settings", activity: "Activity" };

/** Tab names for a specific server: the add-ons tab is "Mods" on mod loaders. */
export function serverTabLabel(server: Pick<MinecraftServer, "type"> | undefined, tab: ServerTab) {
  if (tab === "plugins" && server && ["FABRIC", "QUILT", "FORGE", "NEOFORGE"].includes(server.type)) return "Mods";
  return tabLabels[tab];
}

export function serverHref(id: string, tab: ServerTab = "overview") {
  return `/servers/${id}${tab === "overview" ? "" : `/${tab}`}`;
}

export const initialForm: ServerForm = {
  name: "", type: "PAPER", version: "LATEST", javaVersion: "auto", memory: "4G", cpuLimit: "0", port: "25565", difficulty: "normal",
  maxPlayers: "20", whitelist: "", seed: "", motd: "A Minecraft Server powered by Blocky", customProperties: "",
  initialMemoryPercent: "25", maxMemoryPercent: "75", rollingLogMaxFiles: "30", viewDistance: "8", simulationDistance: "6",
  stopAnnounceDelaySeconds: "10", useMeowiceFlags: true, pauseWhenEmptySeconds: "300", modrinthProjects: [], eula: false,
  gameMode: "survival", pvp: true, hardcore: false, allowFlight: false, commandBlocks: false, onlineMode: true, spawnProtection: "16",
};

export function toPayload(form: ServerForm): ServerConfig & { eula?: boolean } {
  return {
    ...form,
    port: Number(form.port), cpuLimit: Number(form.cpuLimit || 0), maxPlayers: Number(form.maxPlayers),
    initialMemoryPercent: Number(form.initialMemoryPercent), maxMemoryPercent: Number(form.maxMemoryPercent),
    rollingLogMaxFiles: Number(form.rollingLogMaxFiles), viewDistance: Number(form.viewDistance), simulationDistance: Number(form.simulationDistance),
    stopAnnounceDelaySeconds: Number(form.stopAnnounceDelaySeconds), pauseWhenEmptySeconds: Number(form.pauseWhenEmptySeconds),
    spawnProtection: Number(form.spawnProtection),
    whitelist: form.whitelist.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
  };
}

export function fromServer(server: MinecraftServer): ServerForm {
  return {
    name: server.name, type: server.type, version: server.version, javaVersion: server.javaVersion || "auto", memory: server.memory,
    cpuLimit: String(server.cpuLimit || 0), port: String(server.port), difficulty: server.difficulty, maxPlayers: String(server.maxPlayers),
    whitelist: server.whitelist.join("\n"), seed: server.seed, motd: server.motd, customProperties: server.customProperties,
    initialMemoryPercent: String(server.initialMemoryPercent), maxMemoryPercent: String(server.maxMemoryPercent),
    rollingLogMaxFiles: String(server.rollingLogMaxFiles), viewDistance: String(server.viewDistance), simulationDistance: String(server.simulationDistance),
    stopAnnounceDelaySeconds: String(server.stopAnnounceDelaySeconds), useMeowiceFlags: server.useMeowiceFlags, pauseWhenEmptySeconds: String(server.pauseWhenEmptySeconds),
    modrinthProjects: server.modrinthProjects || [],
    gameMode: server.gameMode || "survival", pvp: server.pvp ?? true, hardcore: server.hardcore ?? false, allowFlight: server.allowFlight ?? false,
    commandBlocks: server.commandBlocks ?? false, onlineMode: server.onlineMode ?? true, spawnProtection: String(server.spawnProtection ?? 16),
  };
}

const fieldLabels: Partial<Record<keyof ServerForm, string>> = {
  name: "Name", type: "Server type", version: "Minecraft version", javaVersion: "Java", memory: "Memory", cpuLimit: "CPU limit", port: "Port",
  difficulty: "Difficulty", maxPlayers: "Max players", whitelist: "Whitelist", seed: "World seed", motd: "Message of the day",
  customProperties: "Custom properties", initialMemoryPercent: "Initial heap", maxMemoryPercent: "Maximum heap", rollingLogMaxFiles: "Log files kept",
  viewDistance: "View distance", simulationDistance: "Simulation distance", stopAnnounceDelaySeconds: "Shutdown warning",
  useMeowiceFlags: "Optimized JVM flags", pauseWhenEmptySeconds: "Pause when empty", modrinthProjects: "Plugins and mods",
  gameMode: "Game mode", pvp: "PvP", hardcore: "Hardcore", allowFlight: "Allow flight", commandBlocks: "Command blocks", onlineMode: "Online mode", spawnProtection: "Spawn protection",
};

/** Human-readable list of settings that differ between two forms, for the apply confirmation. */
export function formChanges(before: ServerForm, after: ServerForm) {
  const show = (key: keyof ServerForm, value: unknown) => {
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (Array.isArray(value)) return `${value.length} installed`;
    if (key === "pauseWhenEmptySeconds") return value === "-1" ? "Never" : `${value}s`;
    const text = String(value ?? "").trim();
    return text.length > 40 ? `${text.slice(0, 37)}…` : text || "(empty)";
  };
  return (Object.keys(fieldLabels) as (keyof ServerForm)[])
    .filter((key) => String(before[key] ?? "").trim() !== String(after[key] ?? "").trim())
    .map((key) => ({ key, label: fieldLabels[key]!, from: show(key, before[key]), to: show(key, after[key]) }));
}

export function formatBytes(value: number) {
  if (!value) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

export function formatMb(value: number) {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

export function formatDate(value?: string) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const relative = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : undefined;

/** "2 hours ago", "in 3 hours", "yesterday". */
export function formatRelative(value: string | number | undefined, now = Date.now()) {
  if (value === undefined) return "never";
  const diff = (typeof value === "number" ? value : new Date(value).getTime()) - now;
  const abs = Math.abs(diff);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["second", 1000], ["minute", 60_000], ["hour", 3_600_000], ["day", 86_400_000], ["week", 604_800_000], ["month", 2_592_000_000], ["year", 31_536_000_000]];
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let size = 1000;
  for (const [candidate, ms] of steps) if (abs >= ms) { unit = candidate; size = ms; }
  // Small clock differences between the browser and server shouldn't read as "in a moment".
  if (abs < 10_000 || (diff > 0 && abs < 120_000)) return "just now";
  return relative ? relative.format(Math.round(diff / size), unit) : formatDate(new Date(now + diff).toISOString());
}

export function dayLabel(value: string, now = new Date()) {
  const date = new Date(value);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: days < 7 ? "long" : undefined, month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" }).format(date);
}

export type BackupKind = "scheduled" | "manual" | "safety";

export function backupKind(backup: Pick<Backup, "kind">): BackupKind {
  if (backup.kind.startsWith("pre-")) return "safety";
  return backup.kind === "scheduled" ? "scheduled" : "manual";
}

export const backupKindLabels: Record<BackupKind, string> = { scheduled: "Scheduled", manual: "Manual", safety: "Safety" };

/** Why a safety backup exists, e.g. "before a settings change". */
export function safetyReason(kind: string) {
  const reason = kind.replace(/^pre-/, "");
  return reason === "settings" ? "before a settings change" : reason === "update" ? "before a software update" : reason === "restore" ? "before a restore" : `before ${reason}`;
}

/** The address players type into Minecraft. The default port is omitted. */
/** The address players type in. Minecraft's default port is omitted because the client adds it. */
export function serverAddress(port: number, publicHost?: string, omitDefault = true) {
  const host = publicHost || (typeof window !== "undefined" ? window.location.hostname : "localhost");
  return omitDefault && port === 25565 ? host : `${host}:${port}`;
}

/** "Paper 1.21.8". */
export function serverKind(server: MinecraftServer) {
  return `${serverTypes.find((item) => item.value === server.type)?.label || server.type} ${server.version}`;
}

export function nextFreePort(servers: MinecraftServer[]) {
  const used = new Set(servers.map((server) => server.port));
  let port = 25565;
  while (used.has(port)) port += 1;
  return port;
}

export function readableStatus(server: MinecraftServer) {
  if (server.operation) return server.operation.label;
  if (server.status === "running" && server.health === "starting") return "Starting";
  if (server.health === "unhealthy") return "Unhealthy";
  return server.status.charAt(0).toUpperCase() + server.status.slice(1);
}

export function storageGet(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function storageSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}
