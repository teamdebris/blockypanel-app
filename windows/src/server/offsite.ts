import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SecretBox } from "../../../lib/secret-box";
import { describeDestination, passphraseProblem, repositoryFor, scrubSecrets, secretsOf, type OffsiteDestination, type OffsiteIndex } from "../../../lib/offsite-core";
import { addKey, copyServer, createIndex, listWorldSnapshots, readIndex, repositoryExists, restoreWorld, ResticError, writeIndex, writeSettingsSnapshot, type Runner } from "../../../lib/offsite-restic";
import { createBackup, newBackupName, restoreBackup } from "./backups";
import { getControl, recordEvent } from "./control";
import { HttpError } from "./errors";
import { JsonStore } from "./json-store";
import { withServerLock } from "./operations";
import { assertFilesStopped } from "./files";
import { backupDir, DATA_ROOT, serverDir } from "./paths";
import { localRepository, runRestic } from "./restic";
import { getServer, loadServers, type ServerConfig } from "./store";

type Destination = Extract<OffsiteDestination, { kind: "folder" | "s3" }>;
type Config = { destination: Destination; panelPassword: string; keep: number; afterBackup: boolean };
type CopyStatus = { lastCopyAt?: string; lastError?: string };
type State = { version: 1; panelId: string; sealed?: string; copies: Record<string, CopyStatus> };
const store = new JsonStore<State>(path.join(DATA_ROOT, "offsite.json"), () => ({ version: 1, panelId: randomUUID(), copies: {} }), (value): value is State => {
  const state = value as State;
  return state?.version === 1 && typeof state.panelId === "string" && !!state.copies && typeof state.copies === "object";
});
const lock = <T>(work: () => Promise<T>) => withServerLock("panel-offsite", "off-site backup operation", work);

async function box(create: boolean) {
  const keyFile = path.join(DATA_ROOT, "secret.key");
  try {
    const info = await lstat(keyFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error("secret.key is invalid. Restore the original key before using saved backup credentials.");
    return new SecretBox(await readFile(keyFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) throw new Error("secret.key is missing. Restore it from a copy of your Blocky data folder to read saved backup credentials.");
    await mkdir(DATA_ROOT, { recursive: true });
    try { await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError; }
    return box(false);
  }
}
async function config() {
  const state = await store.read();
  if (!state.sealed) return undefined;
  const opened = (await box(false)).open(state.sealed);
  if (!opened) throw new Error("Saved off-site credentials could not be decrypted. Restore the original secret.key or disconnect and configure this destination again.");
  return JSON.parse(opened) as Config;
}

async function canonical(requested: string): Promise<string> {
  try { return await realpath(requested); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(requested);
    if (parent === requested) throw new HttpError(400, "Choose an existing drive or network share.");
    return path.join(await canonical(parent), path.basename(requested));
  }
}
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export async function parseDestination(value: unknown): Promise<Destination> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Choose a destination.");
  const input = value as Record<string, unknown>;
  if (input.kind === "folder") {
    if (typeof input.path !== "string" || input.path.length > 1000 || /[\0\r\n]/.test(input.path) || !path.isAbsolute(input.path)) throw new HttpError(400, "Use an absolute path to a dedicated backup folder.");
    const destination = path.resolve(input.path);
    if (destination === path.parse(destination).root) throw new HttpError(400, "Choose a dedicated folder, not an entire drive or share.");
    const actual = await canonical(destination), data = await canonical(DATA_ROOT);
    if (inside(actual, data) || inside(data, actual)) throw new HttpError(400, "Choose a backup folder outside Blocky's data folder and its parent folders.");
    for (const system of [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((item): item is string => !!item)) {
      if (inside(await canonical(system), actual)) throw new HttpError(400, "Choose a backup folder outside Windows and Program Files.");
    }
    return { kind: "folder", path: actual };
  }
  if (input.kind !== "s3" || !["b2", "r2", "wasabi", "aws", "minio", "other"].includes(String(input.provider))) throw new HttpError(400, "Choose a folder or an S3-compatible destination.");
  const text = (key: string, max: number) => { const value = input[key]; if (typeof value !== "string" || value.length > max || /[\0\r\n]/.test(value)) throw new HttpError(400, `Invalid ${key}.`); return value.trim(); };
  const bucket = text("bucket", 63), prefix = text("prefix", 200), region = text("region", 64), endpoint = text("endpoint", 300), accessKeyId = text("accessKeyId", 256), secretAccessKey = text("secretAccessKey", 1024);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-zA-Z0-9._/-]*$/.test(prefix) || prefix.split("/").some((part) => part === "." || part === "..") || !/^[a-z0-9-]*$/.test(region) || !accessKeyId || !secretAccessKey) throw new HttpError(400, "Check the bucket, prefix, region, and access keys.");
  if (["r2", "minio", "other"].includes(String(input.provider))) {
    let parsed: URL;
    try { parsed = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`); } catch { throw new HttpError(400, "Enter a valid HTTPS endpoint."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new HttpError(400, "Use an HTTPS endpoint without a path or embedded credentials.");
  }
  if (["b2", "aws", "wasabi"].includes(String(input.provider)) && !region) throw new HttpError(400, "Enter the bucket's region.");
  return { kind: "s3", provider: input.provider as Extract<Destination, { kind: "s3" }>["provider"], endpoint, region, bucket, prefix, accessKeyId, secretAccessKey };
}

function target(destination: Destination) {
  const env: Record<string, string> = destination.kind === "s3" ? { AWS_ACCESS_KEY_ID: destination.accessKeyId, AWS_SECRET_ACCESS_KEY: destination.secretAccessKey || "", AWS_DEFAULT_REGION: destination.region || "us-east-1" } : {};
  const runner: Runner = {
    localRepository: (id) => path.join(backupDir(id), "restic"), dataFolder: serverDir,
    run: async (args, options) => {
      try { return await runRestic(args, { ...options, env }); }
      catch (error) {
        const message = scrubSecrets(error instanceof Error ? error.message : "Off-site backup failed.", [...secretsOf(destination), options.password, options.from?.password || ""]);
        throw new ResticError(message, typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1);
      }
    },
  };
  return { runner, index: repositoryFor(destination, "index"), server: (id: string) => repositoryFor(destination, { server: id }) };
}

export async function offsiteStatus() {
  const state = await store.read(); const current = await config();
  const servers = await loadServers();
  return { configured: !!current, description: current ? describeDestination(current.destination) : undefined, keep: current?.keep, afterBackup: current?.afterBackup,
    servers: await Promise.all(servers.map(async (server) => ({ id: server.id, name: server.name, incremental: (await getControl(server.id)).backupPolicy.mode === "incremental", ...state.copies[server.id] }))) };
}

export async function configureOffsite(input: { destination: unknown; passphrase: unknown; keep: unknown; afterBackup: unknown }) {
  return lock(async () => {
    if (typeof input.passphrase !== "string" || input.passphrase.length > 1024 || passphraseProblem(input.passphrase)) throw new HttpError(400, passphraseProblem(typeof input.passphrase === "string" ? input.passphrase : "") || "Invalid passphrase.");
    if (!Number.isInteger(input.keep) || Number(input.keep) < 1 || Number(input.keep) > 500 || typeof input.afterBackup !== "boolean") throw new HttpError(400, "Keep 1–500 copies and choose a schedule.");
    const destination = await parseDestination(input.destination);
    if (destination.kind === "folder") await mkdir(destination.path, { recursive: true });
    const state = await store.read();
    const cipher = await box(!state.sealed);
    const panelPassword = randomBytes(32).toString("hex");
    const to = target(destination);
    if (await repositoryExists(to.runner, to.index, panelPassword)) {
      const existing = await readIndex(to.runner, to.index, input.passphrase);
      if (existing.panelId !== state.panelId) throw new HttpError(409, "This destination belongs to another panel. Use recovery to restore its backups, or choose a separate folder/prefix for new copies.");
      await addKey(to.runner, to.index, input.passphrase, panelPassword);
    } else {
      const index: OffsiteIndex = { version: 1, panelId: state.panelId, updatedAt: new Date().toISOString(), servers: {} };
      await createIndex(to.runner, to.index, panelPassword, input.passphrase, index);
    }
    const current: Config = { destination, panelPassword, keep: Number(input.keep), afterBackup: input.afterBackup };
    const sealed = cipher.seal(JSON.stringify(current));
    await store.change((next) => { next.sealed = sealed; });
    return offsiteStatus();
  });
}
export async function disconnectOffsite() { await lock(() => store.change((state) => { delete state.sealed; state.copies = {}; })); }

export async function copyOffsite(id: string, fresh = false) {
  return lock(async () => {
    const current = await config(); if (!current) throw new HttpError(400, "Configure an off-site destination first.");
    const server = await getServer(id); if (!server) throw new HttpError(404, "Server not found.");
    if ((await getControl(id)).backupPolicy.mode !== "incremental") throw new HttpError(400, "Choose encrypted incremental storage in this server's Backups settings first.");
    const to = target(current.destination);
    try {
      if (fresh) await createBackup(id);
      const local = await localRepository(id); if (!local) throw new HttpError(400, "Create an incremental backup first.");
      await copyServer(to.runner, { serverId: id, repository: to.server(id), password: local.password, keep: current.keep });
      await writeSettingsSnapshot(to.runner, to.server(id), local.password, { server, addons: (await getControl(id)).addons || [] });
      const index = await readIndex(to.runner, to.index, current.panelPassword);
      const now = new Date().toISOString();
      index.servers[id] = { name: server.name, type: server.software.toUpperCase(), version: server.version, repositoryPassword: local.password, lastCopyAt: now };
      index.updatedAt = now;
      await writeIndex(to.runner, to.index, current.panelPassword, index);
      await store.change((state) => { state.copies[id] = { lastCopyAt: now }; });
      await recordEvent(id, "Encrypted backups copied to the off-site destination.", "success");
      return { ok: true };
    } catch (error) {
      const message = scrubSecrets(error instanceof Error ? error.message : "Off-site backup failed.", [...secretsOf(current.destination), current.panelPassword]);
      await store.change((state) => { state.copies[id] = { ...state.copies[id], lastError: message }; });
      await recordEvent(id, `Off-site copy failed: ${message}`, "error");
      throw new HttpError(502, message);
    }
  });
}
export async function copyOffsiteAfterBackup(id: string) {
  try { const current = await config(); if (current?.afterBackup && (await getControl(id)).backupPolicy.mode === "incremental") await copyOffsite(id); }
  catch (error) { console.error("Off-site copy was not completed:", error instanceof Error ? error.message : "Unknown error"); }
}

async function recovery(input: { destination: unknown; passphrase: unknown }) {
  if (typeof input.passphrase !== "string" || !input.passphrase || input.passphrase.length > 1024) throw new HttpError(400, "Enter the backup passphrase.");
  const destination = await parseDestination(input.destination);
  const to = target(destination);
  const index = await readIndex(to.runner, to.index, input.passphrase);
  return { to, index };
}
export async function discoverOffsite(input: { destination: unknown; passphrase: unknown }) {
  return lock(async () => {
    const { index } = await recovery(input);
    return { servers: Object.entries(index.servers).map(([id, entry]) => ({ id, name: entry.name, type: entry.type, version: entry.version, lastCopyAt: entry.lastCopyAt })) };
  });
}
export async function offsiteSnapshots(input: { destination: unknown; passphrase: unknown; serverId: unknown }) {
  return lock(async () => {
    const { to, index } = await recovery(input);
    if (typeof input.serverId !== "string" || !index.servers[input.serverId]) throw new HttpError(404, "Backup server not found.");
    const entry = index.servers[input.serverId];
    return { snapshots: await listWorldSnapshots(to.runner, to.server(input.serverId), entry.repositoryPassword) };
  });
}
export async function restoreOffsite(server: ServerConfig, input: { destination: unknown; passphrase: unknown; serverId: unknown; snapshotId: unknown }) {
  return lock(async () => {
    assertFilesStopped(server.id);
    const { to, index } = await recovery(input);
    if (typeof input.serverId !== "string" || typeof input.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(input.snapshotId)) throw new HttpError(400, "Choose a backup server and snapshot.");
    const entry = index.servers[input.serverId];
    if (!entry || entry.type !== server.software.toUpperCase() || entry.version !== server.version) throw new HttpError(409, "Restore into a local server using the same server software and Minecraft version as the backup.");
    const snapshot = (await listWorldSnapshots(to.runner, to.server(input.serverId), entry.repositoryPassword)).find((snapshot) => snapshot.id === input.snapshotId);
    if (!snapshot) throw new HttpError(404, "Snapshot not found.");
    await mkdir(backupDir(server.id), { recursive: true });
    if ((await lstat(backupDir(server.id))).isSymbolicLink()) throw new HttpError(400, "The backup folder cannot be a link.");
    const temporary = path.join(backupDir(server.id), `recovery-${randomUUID()}.partial`); await mkdir(temporary);
    const name = newBackupName("manual"), completed = path.join(backupDir(server.id), name);
    try {
      await restoreWorld({ ...to.runner, dataFolder: () => temporary }, { serverId: server.id, repository: to.server(input.serverId), password: entry.repositoryPassword, snapshotId: snapshot.id, path: snapshot.path });
      await rename(temporary, completed);
      await restoreBackup(server.id, name);
      await recordEvent(server.id, "Off-site snapshot restored; the previous local world was saved in a safety backup.", "success");
      return { ok: true };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}
