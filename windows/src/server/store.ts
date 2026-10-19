import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { DATA_ROOT, STATE_FILE } from "./paths";

export type Software = "paper" | "vanilla";
export type Difficulty = "peaceful" | "easy" | "normal" | "hard";

export type ServerConfig = {
  id: string; name: string; software: Software; version: string; memoryMb: number; port: number;
  motd: string; maxPlayers: number; difficulty: Difficulty; icon: string; createdAt: string;
};

export const ICONS = ["grass", "dirt", "stone", "sand", "snow", "water", "oak-log", "copper-ore", "creeper", "zombie", "skeleton", "enderman", "pig", "cow", "sheep", "villager"];

let cache: ServerConfig[] | undefined;
let writing = Promise.resolve();

export async function loadServers(): Promise<ServerConfig[]> {
  if (cache) return cache;
  try { cache = (JSON.parse(await readFile(STATE_FILE, "utf8")) as { servers: ServerConfig[] }).servers ?? []; }
  catch { cache = []; }
  return cache;
}

/** Saved atomically (write then rename), one write at a time. */
async function save() {
  const servers = cache ?? [];
  writing = writing.then(async () => {
    await mkdir(DATA_ROOT, { recursive: true });
    const temp = `${STATE_FILE}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, servers }, null, 2));
    await rename(temp, STATE_FILE);
  });
  return writing;
}

export async function getServer(id: string) {
  return (await loadServers()).find((server) => server.id === id);
}

export async function addServer(config: Omit<ServerConfig, "id" | "createdAt">) {
  const servers = await loadServers();
  const server: ServerConfig = { ...config, id: randomBytes(6).toString("hex"), createdAt: new Date().toISOString() };
  servers.push(server);
  await save();
  return server;
}

export async function updateServer(id: string, changes: Partial<Omit<ServerConfig, "id" | "createdAt" | "software">>) {
  const server = await getServer(id);
  if (!server) throw new Error("That server doesn't exist.");
  Object.assign(server, changes);
  await save();
  return server;
}

export async function removeServer(id: string) {
  cache = (await loadServers()).filter((server) => server.id !== id);
  await save();
}
