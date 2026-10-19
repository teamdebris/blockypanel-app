export type Status = "stopped" | "installing" | "starting" | "running" | "stopping" | "crashed";
export type Server = {
  id: string; name: string; software: "paper" | "purpur" | "vanilla" | "fabric" | "quilt" | "forge" | "neoforge"; version: string; memoryMb: number; port: number;
  motd: string; maxPlayers: number; difficulty: "peaceful" | "easy" | "normal" | "hard"; icon: string; createdAt: string;
  gameMode: "survival" | "creative" | "adventure" | "spectator"; pvp: boolean; hardcore: boolean; allowFlight: boolean; commandBlocks: boolean;
  onlineMode: boolean; spawnProtection: number; viewDistance: number; simulationDistance: number; seed: string; operation?: string;
  status: Status; step?: string; progress?: number; players: string[]; startedAt?: number; memoryUsedMb?: number; lastError?: string; address: string;
};
export type State = { version: string; dataRoot: string; servers: Server[] };
export type Line = { at: number; text: string; kind: "out" | "err" | "command" | "panel" };
export type Backup = { name: string; createdAt: string; sizeBytes: number; kind: "manual" | "safety" | "scheduled"; storage?: "copy" | "incremental" };
export const SOFTWARE_LABELS = { paper: "Paper", purpur: "Purpur", vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" } as const;

/** JSON API calls. Changes carry the verification header the server requires. */
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "x-blocky-request": "1", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status}).`);
  return data as T;
}

export const MEMORY_OPTIONS = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384];
export const ICONS = ["grass", "dirt", "stone", "sand", "snow", "water", "oak-log", "copper-ore", "creeper", "zombie", "skeleton", "enderman", "pig", "cow", "sheep", "villager"];

export function formatBytes(bytes: number) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatRelative(iso: string | number) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"]];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, name] = units[i];
    if (seconds >= size) { const n = Math.round(seconds / size); return `${n} ${name}${n === 1 ? "" : "s"} ago`; }
  }
  return "just now";
}

export function uptime(startedAt: number) {
  const minutes = Math.floor((Date.now() - startedAt) / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
