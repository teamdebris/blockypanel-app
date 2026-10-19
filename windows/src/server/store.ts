import { randomBytes } from "node:crypto";
import { STATE_FILE } from "./paths";
import { JsonStore } from "./json-store";
import { HttpError } from "./errors";

export const SOFTWARE = ["paper", "purpur", "vanilla", "fabric", "quilt", "forge", "neoforge"] as const;
export type Software = (typeof SOFTWARE)[number];
export type Difficulty = "peaceful" | "easy" | "normal" | "hard";
export type GameMode = "survival" | "creative" | "adventure" | "spectator";

export type ServerConfig = {
  id: string; name: string; software: Software; version: string; memoryMb: number; port: number;
  motd: string; maxPlayers: number; difficulty: Difficulty; icon: string; createdAt: string;
  gameMode: GameMode; pvp: boolean; hardcore: boolean; allowFlight: boolean; commandBlocks: boolean;
  onlineMode: boolean; spawnProtection: number; viewDistance: number; simulationDistance: number; seed: string;
};

export const GAME_DEFAULTS = { gameMode: "survival" as GameMode, pvp: true, hardcore: false, allowFlight: false, commandBlocks: false, onlineMode: true, spawnProtection: 16, viewDistance: 10, simulationDistance: 10, seed: "" };

export const ICONS = ["grass", "dirt", "stone", "sand", "snow", "water", "oak-log", "copper-ore", "creeper", "zombie", "skeleton", "enderman", "pig", "cow", "sheep", "villager"];

type State = { version: 1; servers: ServerConfig[] };
const valid = (value: unknown): value is State => {
  const state = value as State;
  return state?.version === 1 && Array.isArray(state.servers) && state.servers.every((s) => typeof s.id === "string" && /^[a-z0-9]{12}$/.test(s.id) && typeof s.name === "string" && typeof s.port === "number");
};
const store = new JsonStore<State>(STATE_FILE, () => ({ version: 1, servers: [] }), valid);
export const loadServers = async () => (await store.read()).servers.map((server) => ({ ...GAME_DEFAULTS, ...server }));
export const getServer = async (id: string) => (await loadServers()).find((server) => server.id === id);

export async function addServer(config: Omit<ServerConfig, "id" | "createdAt">) {
  return store.change((state) => {
    if (state.servers.some((server) => server.port === config.port)) throw new HttpError(409, "Another server already uses that port.");
    const server: ServerConfig = { ...config, id: randomBytes(6).toString("hex"), createdAt: new Date().toISOString() };
    state.servers.push(server);
    return server;
  });
}

export async function updateServer(id: string, changes: Partial<Omit<ServerConfig, "id" | "createdAt" | "software">>) {
  return store.change((state) => {
    const server = state.servers.find((server) => server.id === id);
    if (!server) throw new HttpError(404, "That server doesn't exist.");
    if (changes.port !== undefined && state.servers.some((other) => other.id !== id && other.port === changes.port)) throw new HttpError(409, "Another server already uses that port.");
    Object.assign(server, changes);
    return { ...GAME_DEFAULTS, ...server };
  });
}

export async function removeServer(id: string) {
  await store.change((state) => { state.servers = state.servers.filter((server) => server.id !== id); });
}
