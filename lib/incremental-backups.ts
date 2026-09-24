import "server-only";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { resticCachePath, serverBackupPath, serverDataPath, storagePath } from "@/lib/paths";

const SNAPSHOT_NAME = /^snapshot-([0-9a-f]{64})$/;

type ResticSnapshot = {
  id: string;
  time: string;
  paths: string[];
  tags?: string[];
  summary?: { data_added_packed?: number; total_bytes_processed?: number };
};

function locations(serverId: string) {
  const root = serverBackupPath(serverId);
  return { root, repository: storagePath(root, "restic"), password: storagePath(root, "restic-password") };
}

async function exists(file: string) {
  try { await access(file, constants.F_OK); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function resticEnvironment(serverId: string, repository = locations(serverId).repository) {
  const { password } = locations(serverId);
  return { ...process.env, RESTIC_REPOSITORY: repository, RESTIC_PASSWORD_FILE: password, RESTIC_CACHE_DIR: resticCachePath() };
}

/**
 * Runs restic and returns stdout. When `onLine` is given, stdout is streamed line by line and not
 * buffered, so long-running JSON progress output can't exhaust memory.
 */
function runRestic(serverId: string, args: string[], options: { repository?: string; extraEnv?: Record<string, string>; onLine?: (line: string) => void } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("restic", ["--retry-lock", "1m", ...args], {
      env: { ...resticEnvironment(serverId, options.repository), ...options.extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let pending = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (!options.onLine) { stdout += chunk.toString(); return; }
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) if (line.trim()) options.onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on("error", (error) => reject(new Error(`Could not run restic: ${error.message}`)));
    child.on("close", (code) => {
      if (options.onLine && pending.trim()) options.onLine(pending);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Incremental backup failed: ${stderr.trim() || `restic exited with ${code}`}`));
    });
  });
}

async function ensureIncrementalRepository(serverId: string) {
  const { root, repository, password } = locations(serverId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(resticCachePath(), { recursive: true, mode: 0o700 });
  try { await writeFile(password, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!(await exists(path.join(repository, "config")))) await runRestic(serverId, ["init"]);
}

export async function listIncrementalSnapshots(serverId: string): Promise<ResticSnapshot[]> {
  const { repository, password } = locations(serverId);
  if (!(await exists(path.join(repository, "config")))) return [];
  if (!(await exists(password))) throw new Error("Incremental backup password file is missing. Restore it before using the repository.");
  return JSON.parse(await runRestic(serverId, ["snapshots", "--json"])) as ResticSnapshot[];
}

export async function createIncrementalSnapshot(serverId: string, kind: string) {
  await ensureIncrementalRepository(serverId);
  let snapshotId = "";
  await runRestic(serverId, ["backup", "--json", "--tag", `kind:${kind}`, serverDataPath(serverId)], {
    onLine: (line) => {
      try {
        const message = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        if (message.message_type === "summary" && message.snapshot_id) snapshotId = message.snapshot_id;
      } catch { /* non-JSON diagnostic line */ }
    },
  });
  if (!snapshotId) throw new Error("Restic did not report a completed snapshot.");
  return `snapshot-${snapshotId}`;
}


export async function getIncrementalSnapshot(serverId: string, name: string) {
  const match = SNAPSHOT_NAME.exec(name);
  if (!match) throw new BadRequestError("Invalid snapshot name.");
  const snapshot = (await listIncrementalSnapshots(serverId)).find((item) => item.id === match[1]);
  if (!snapshot || snapshot.paths.length !== 1) throw new NotFoundError("Snapshot not found.");
  return snapshot;
}

export async function restoreIncrementalSnapshot(serverId: string, name: string) {
  const snapshot = await getIncrementalSnapshot(serverId, name);
  await runRestic(serverId, ["restore", `${snapshot.id}:${snapshot.paths[0]}`, "--target", serverDataPath(serverId)]);
}

/** Forgets snapshots without pruning; unreferenced data is reclaimed by the periodic maintenance prune. */
export async function forgetIncrementalSnapshots(serverId: string, names: string[]) {
  if (!names.length) return;
  const ids = await Promise.all(names.map(async (name) => (await getIncrementalSnapshot(serverId, name)).id));
  await runRestic(serverId, ["forget", ...ids]);
}

export async function pruneIncrementalRepository(serverId: string) {
  if (!(await exists(path.join(locations(serverId).repository, "config")))) return;
  await runRestic(serverId, ["prune", "--max-unused", "10%"]);
}

/** Verifies repository structure and metadata (not every data blob, which would read the whole repository). */
export async function checkIncrementalRepository(serverId: string) {
  if (!(await exists(path.join(locations(serverId).repository, "config")))) return;
  await runRestic(serverId, ["check"]);
}

/** A server's local repository and its password, for copying offsite. Undefined when it has no backups yet. */
export async function localRepository(serverId: string) {
  const { repository, password } = locations(serverId);
  if (!(await exists(path.join(repository, "config"))) || !(await exists(password))) return undefined;
  return { repository, password: (await readFile(password, "utf8")).trim() };
}

/**
 * Prepares the local backups of a server restored from offsite: its password must be the one its
 * offsite repository uses, so later copies go to the same place. restic creates the repository.
 */
export async function writeLocalRepositoryPassword(serverId: string, password: string) {
  const { root, password: passwordFile } = locations(serverId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(resticCachePath(), { recursive: true, mode: 0o700 });
  await writeFile(passwordFile, `${password}\n`, { flag: "wx", mode: 0o600 });
}

export function openIncrementalDownload(serverId: string, snapshot: ResticSnapshot, signal?: AbortSignal) {
  const child = spawn("restic", ["--retry-lock", "1m", "dump", `${snapshot.id}:${snapshot.paths[0]}`, "/"], {
    env: resticEnvironment(serverId), stdio: ["ignore", "pipe", "pipe"], signal,
  });
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8192); });
  child.on("error", (failure) => child.stdout.destroy(failure));
  child.on("close", (code) => { if (code && !child.stdout.destroyed) child.stdout.destroy(new Error(error.trim() || `Restic exited with ${code}.`)); });
  return child.stdout;
}

export function incrementalBackupRecord(snapshot: ResticSnapshot) {
  return {
    name: `snapshot-${snapshot.id}`,
    size: snapshot.summary?.data_added_packed || 0,
    logicalSize: snapshot.summary?.total_bytes_processed || 0,
    createdAt: snapshot.time,
    kind: snapshot.tags?.find((tag) => tag.startsWith("kind:"))?.slice(5) || "manual",
  };
}
