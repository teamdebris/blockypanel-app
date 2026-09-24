import { spawn } from "node:child_process";
import { type OffsiteIndex, parseIndex, serializeIndex } from "./offsite-core.ts";

/**
 * restic operations for offsite backups, independent of where restic runs. A Runner executes
 * restic (in the panel, or in a helper container that mounts a folder destination) and says how
 * restic sees a server's local repository and data folder. No Next.js imports, so the
 * integration test drives this with a real restic binary and temporary folders.
 */

export type RunOptions = {
  repository: string;
  password: string;
  /** For `copy` and `init --copy-chunker-params`: the repository to read from. */
  from?: { repository: string; password: string };
  stdin?: string;
  /** Aborts the run (a connection test that takes too long). */
  signal?: AbortSignal;
};

export interface Runner {
  run(args: string[], options: RunOptions): Promise<string>;
  /** A server's local repository, as the restic process sees it. */
  localRepository(serverId: string): string;
  /** A server's data folder (restore target), as the restic process sees it. */
  dataFolder(serverId: string): string;
}

/** restic exit codes (0.17+): 10 = no repository at that location, 12 = wrong password. */
export class ResticError extends Error {
  readonly code: number;
  constructor(message: string, code: number) { super(message); this.name = "ResticError"; this.code = code; }
}

export const NO_REPOSITORY = 10;
export const WRONG_PASSWORD = 12;

type Snapshot = { id: string; short_id?: string; time: string; paths: string[]; tags?: string[]; summary?: { total_bytes_processed?: number } };

/** Runs a restic binary directly, with credentials passed only through the environment. */
export function directRunner(options: { binary?: string; env?: Record<string, string>; args?: string[]; cacheDir?: string; localRepository: (id: string) => string; dataFolder: (id: string) => string }): Runner {
  return {
    localRepository: options.localRepository,
    dataFolder: options.dataFolder,
    run(args, run) {
      return new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env, ...options.env,
          RESTIC_REPOSITORY: run.repository, RESTIC_PASSWORD: run.password,
          ...(options.cacheDir ? { RESTIC_CACHE_DIR: options.cacheDir } : {}),
          ...(run.from ? { RESTIC_FROM_REPOSITORY: run.from.repository, RESTIC_FROM_PASSWORD: run.from.password } : {}),
        };
        const child = spawn(options.binary || "restic", ["--retry-lock", "1m", ...(options.args || []), ...args], { env, signal: run.signal, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
        child.on("error", (error) => reject(error.name === "AbortError" ? new Error("The destination didn't answer in time.") : new Error(`Could not run restic: ${error.message}`)));
        child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new ResticError(stderr.trim().split("\n").filter((line) => !line.startsWith("Is there a repository")).join(" ").trim() || `restic exited with ${code}`, code ?? -1)));
        child.stdin.on("error", () => undefined);
        child.stdin.end(run.stdin ?? "");
      });
    },
  };
}

// ---- The index ----

/** Whether a repository exists (true), doesn't exist (false). Throws on other errors (auth, network). */
export async function repositoryExists(runner: Runner, repository: string, password: string, signal?: AbortSignal) {
  try { await runner.run(["cat", "config"], { repository, password, signal }); return true; }
  catch (error) {
    if (isNoRepository(error)) return false;
    if (isWrongPassword(error)) return true;
    throw error;
  }
}

// restic before 0.17 exits with 1 for everything, so the messages are checked too.
export function isNoRepository(error: unknown) {
  return error instanceof ResticError && (error.code === NO_REPOSITORY || /repository does not exist|unable to open config file/i.test(error.message));
}

export function isWrongPassword(error: unknown) {
  return error instanceof ResticError && (error.code === WRONG_PASSWORD || /wrong password or no key found/i.test(error.message));
}

/** Creates the index, opened by `panelPassword` and by the owner's passphrase as a second key. Returns the passphrase key's ID. */
export async function createIndex(runner: Runner, repository: string, panelPassword: string, passphrase: string, index: OffsiteIndex) {
  await runner.run(["init"], { repository, password: panelPassword });
  const keyId = await addKey(runner, repository, panelPassword, passphrase);
  await writeIndex(runner, repository, panelPassword, index);
  return keyId;
}

export async function readIndex(runner: Runner, repository: string, password: string) {
  return parseIndex(await runner.run(["dump", "--tag", "blocky-index", "latest", "/index.json"], { repository, password }));
}

export async function writeIndex(runner: Runner, repository: string, password: string, index: OffsiteIndex) {
  await runner.run(["backup", "--quiet", "--stdin", "--stdin-filename", "index.json", "--tag", "blocky-index"], { repository, password, stdin: serializeIndex(index) });
  await runner.run(["forget", "--quiet", "--tag", "blocky-index", "--keep-last", "10"], { repository, password });
}

type Key = { id: string; current: boolean };

async function listKeys(runner: Runner, repository: string, password: string) {
  return JSON.parse(await runner.run(["key", "list", "--json"], { repository, password })) as Key[];
}

/** The ID of the key `password` opens. */
export async function currentKeyId(runner: Runner, repository: string, password: string) {
  const key = (await listKeys(runner, repository, password)).find((item) => item.current);
  if (!key) throw new Error("restic didn't report the key in use.");
  return key.id;
}

/** Adds `newPassword` as a key (read from stdin, so it never touches disk) and returns its ID. */
export async function addKey(runner: Runner, repository: string, password: string, newPassword: string) {
  const before = new Set((await listKeys(runner, repository, password)).map((key) => key.id));
  await runner.run(["key", "add", "--host", "blocky"], { repository, password, stdin: `${newPassword}\n` });
  const added = (await listKeys(runner, repository, password)).find((key) => !before.has(key.id));
  if (!added) throw new Error("restic didn't report the new key.");
  return added.id;
}

export async function removeKey(runner: Runner, repository: string, password: string, keyId: string) {
  await runner.run(["key", "remove", keyId], { repository, password });
}

// ---- Server repositories ----

/** Copies a server's local snapshots offsite, creating the offsite repository on first use. */
export async function copyServer(runner: Runner, options: { serverId: string; repository: string; password: string; keep: number }) {
  const from = { repository: runner.localRepository(options.serverId), password: options.password };
  if (!(await repositoryExists(runner, options.repository, options.password))) {
    // Same chunker parameters as the local repository, so copies only send what changed.
    await runner.run(["init", "--copy-chunker-params"], { repository: options.repository, password: options.password, from });
  }
  await runner.run(["copy", "--quiet"], { repository: options.repository, password: options.password, from });
  await runner.run(["forget", "--quiet", "--group-by", "tags", "--keep-last", String(Math.max(options.keep, 1))], { repository: options.repository, password: options.password });
}

/** Stores the server's settings (its server.json) next to its world snapshots. */
export async function writeSettingsSnapshot(runner: Runner, repository: string, password: string, settings: object) {
  await runner.run(["backup", "--quiet", "--stdin", "--stdin-filename", "server.json", "--tag", "kind:config"], { repository, password, stdin: JSON.stringify(settings) });
  await runner.run(["forget", "--quiet", "--tag", "kind:config", "--keep-last", "5"], { repository, password });
}

export async function readSettingsSnapshot(runner: Runner, repository: string, password: string) {
  return JSON.parse(await runner.run(["dump", "--tag", "kind:config", "latest", "/server.json"], { repository, password })) as Record<string, unknown>;
}

/** World snapshots (not settings snapshots), newest first. */
export async function listWorldSnapshots(runner: Runner, repository: string, password: string) {
  const snapshots = JSON.parse(await runner.run(["snapshots", "--json"], { repository, password })) as Snapshot[] | null;
  return (snapshots || [])
    .filter((snapshot) => !snapshot.tags?.includes("kind:config") && !snapshot.tags?.includes("blocky-index") && snapshot.paths.length === 1)
    .sort((a, b) => b.time.localeCompare(a.time))
    .map((snapshot) => ({ id: snapshot.id, time: snapshot.time, path: snapshot.paths[0], size: snapshot.summary?.total_bytes_processed || 0, kind: snapshot.tags?.find((tag) => tag.startsWith("kind:"))?.slice(5) || "manual" }));
}

/** Restores a world snapshot into the server's data folder. */
export async function restoreWorld(runner: Runner, options: { serverId: string; repository: string; password: string; snapshotId: string; path: string }) {
  // restic names Windows paths /C/Users/... inside a snapshot (only relevant when developing on Windows).
  const inside = options.path.replace(/^([A-Za-z]):[\\/]/, "/$1/").replaceAll("\\", "/");
  await runner.run(["restore", `${options.snapshotId}:${inside}`, "--target", runner.dataFolder(options.serverId)], { repository: options.repository, password: options.password });
}

/** A new machine's local repository for a restored server: same password and chunker parameters as offsite. */
export async function createLocalFromOffsite(runner: Runner, options: { serverId: string; repository: string; password: string }) {
  await runner.run(["init", "--copy-chunker-params"], { repository: runner.localRepository(options.serverId), password: options.password, from: { repository: options.repository, password: options.password } });
}

export async function pruneRepository(runner: Runner, repository: string, password: string) {
  await runner.run(["prune", "--quiet", "--max-unused", "10%"], { repository, password });
}
