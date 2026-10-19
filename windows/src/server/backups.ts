import { cp, mkdir, readdir, rm, lstat, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { backupDir, serverDir } from "./paths";
import { consoleLines, isActive, runtimeInfo, sendCommand } from "./minecraft";
import { changeControl, getControl, type InstalledAddon } from "./control";
import { createSnapshot, deleteSnapshot, listSnapshots, restoreSnapshot } from "./restic";
import { DATA_ROOT } from "./paths";
import { HttpError } from "./errors";

/** Left out of backups: the server software, logs, and caches, which are downloaded or made again. */
const SKIP = new Set(["cache", "libraries", "versions", "logs", "crash-reports", ".paper-remapped", ".blocky-uploads"]);
// session.lock only marks a world as open; Windows keeps it locked while the server runs, so it can't be copied anyway.
const skip = (name: string) => SKIP.has(name) || name.endsWith(".jar") && !name.includes(path.sep) || name.endsWith(".part") || path.basename(name) === "session.lock";
const NAME = /^\d{8}-\d{6}(?:-\d{3}-[a-f0-9]{8})?(?:-(?:safety|scheduled))?$/;
const META = ".blocky-backup.json";

export type Backup = { name: string; createdAt: string; sizeBytes: number; kind: "manual" | "safety" | "scheduled"; storage?: "copy" | "incremental" };

async function assertTree(dir: string) {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Backup folders must be ordinary directories, not links.");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Remove links and junctions before backing up or restoring this folder.");
    if (entry.isDirectory()) await assertTree(path.join(dir, entry.name));
    else if (!entry.isFile()) throw new Error("Only ordinary files and folders can be backed up.");
  }
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (!entry.isSymbolicLink()) total += entry.isDirectory() ? await sizeOf(full) : (await lstat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function stamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function newBackupName(kind: Backup["kind"]) {
  return `${stamp()}-${String(new Date().getMilliseconds()).padStart(3, "0")}-${randomUUID().slice(0, 8)}${kind === "manual" ? "" : `-${kind}`}`;
}

/** Waits until a console line matching `pattern` appears after `since`, or `timeoutMs` passes. */
async function waitForLine(id: string, pattern: RegExp, since: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (consoleLines(id).some((line) => line.at >= since && pattern.test(line.text))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function listBackups(id: string): Promise<Backup[]> {
  const dir = backupDir(id);
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && NAME.test(entry.name)).map((entry) => entry.name).sort().reverse();
  const copies = await Promise.all(names.map(async (name) => {
    const [date, time] = name.split("-");
    const createdAt = new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6)).toISOString();
    const meta = await readFile(path.join(dir, name, META), "utf8").then((text) => JSON.parse(text) as { createdAt?: string }).catch(() => ({} as { createdAt?: string }));
    return { name, createdAt: meta.createdAt && Number.isFinite(Date.parse(meta.createdAt)) ? meta.createdAt : createdAt, sizeBytes: await sizeOf(path.join(dir, name)), kind: name.endsWith("-safety") ? "safety" as const : name.endsWith("-scheduled") ? "scheduled" as const : "manual" as const };
  }));
  const snapshots: Backup[] = (await listSnapshots(id)).map((snapshot) => ({ name: `snapshot-${snapshot.id}`, createdAt: snapshot.time, sizeBytes: snapshot.summary?.total_bytes_processed || 0, kind: snapshot.tags?.includes("kind:safety") ? "safety" : snapshot.tags?.includes("kind:scheduled") ? "scheduled" : "manual", storage: "incremental" }));
  return [...copies, ...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A copy of the server's folder. A running server saves and pauses writes first, so the copy is consistent. */
export async function createBackup(id: string, kind: Backup["kind"] = "manual") {
  const status = runtimeInfo(id).status;
  if (isActive(id) && status !== "running") throw new HttpError(409, "Wait for the server to finish starting or stopping before making a backup.");
  await mkdir(serverDir(id), { recursive: true });
  await mkdir(backupDir(id), { recursive: true });
  await assertTree(serverDir(id));
  if ((await lstat(backupDir(id))).isSymbolicLink()) throw new Error("Backup folders cannot be links.");
  const target = path.join(backupDir(id), newBackupName(kind));
  const temp = `${target}.partial`;
  const running = status === "running";
  let snapshotMeta = false;
  try {
    if (running) {
      const since = Date.now();
      sendCommand(id, "save-off");
      sendCommand(id, "save-all flush");
      await waitForLine(id, /Saved the game|Saved the world/i, since, 30_000);
    }
    const metadata = { createdAt: new Date().toISOString(), kind, addons: (await getControl(id)).addons ?? [] };
    if ((await getControl(id)).backupPolicy.mode === "incremental") {
      await writeFile(path.join(serverDir(id), META), JSON.stringify(metadata), { flag: "wx" }); snapshotMeta = true;
      return await createSnapshot(id, kind);
    }
    await mkdir(temp);
    await cp(serverDir(id), temp, { recursive: true, dereference: false, filter: (source) => !skip(path.relative(serverDir(id), source)) });
    await assertTree(temp);
    await writeFile(path.join(temp, META), JSON.stringify(metadata));
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM") throw new Error(`A file in the server's folder is in use, so the backup couldn't be made: ${path.basename((error as NodeJS.ErrnoException).path ?? "")}. Try again, or stop the server first.`);
    if (code === "ENOSPC") throw new Error("There isn't enough disk space for the backup.");
    throw error;
  } finally {
    if (snapshotMeta) await rm(path.join(serverDir(id), META), { force: true });
    if (running && runtimeInfo(id).status === "running") sendCommand(id, "save-on");
  }
  return path.basename(target);
}

/** Puts a backup back. The server must be stopped; a safety backup of the current files is taken first. */
export async function restoreBackup(id: string, name: string) {
  const incremental = /^snapshot-[a-f0-9]{64}$/.test(name);
  if (!incremental && !NAME.test(name)) throw new HttpError(400, "That backup doesn't exist.");
  if (isActive(id)) throw new HttpError(409, "Stop the server before restoring a backup.");
  const source = path.join(backupDir(id), name);
  if (!incremental) await assertTree(source);
  const stagingRoot = path.join(DATA_ROOT, "staging"); await mkdir(stagingRoot, { recursive: true });
  if ((await lstat(stagingRoot)).isSymbolicLink()) throw new Error("The staging folder cannot be a link or junction.");
  const stage = path.join(stagingRoot, `restore-${id}-${randomUUID()}`); await mkdir(stage);
  const restored = path.join(stage, "restored"); await mkdir(restored);
  const previous = path.join(stage, "previous"); await mkdir(previous);
  const dir = serverDir(id);
  const moved: string[] = [], installed: string[] = [];
  let preserve = false;
  try {
    if (incremental) await restoreSnapshot(id, name, restored);
    else await cp(source, restored, { recursive: true, dereference: false });
    await assertTree(restored);
    const metadata = await readFile(path.join(restored, META), "utf8").then((text) => JSON.parse(text) as { addons?: InstalledAddon[] }).catch(() => ({} as { addons?: InstalledAddon[] }));
    await createBackup(id, "safety");
    for (const entry of await readdir(dir)) {
      if (skip(entry)) continue;
      await rename(path.join(dir, entry), path.join(previous, entry)); moved.push(entry);
    }
    for (const entry of await readdir(restored)) {
      if (entry === META || skip(entry)) continue;
      await rename(path.join(restored, entry), path.join(dir, entry)); installed.push(entry);
    }
    await changeControl(id, (state) => { state.addons = Array.isArray(metadata.addons) ? metadata.addons : []; });
  } catch (error) {
    try {
      for (const entry of installed) await rename(path.join(dir, entry), path.join(restored, entry));
      for (const entry of moved.reverse()) await rename(path.join(previous, entry), path.join(dir, entry));
    } catch {
      preserve = true;
      throw new Error(`Restore failed and rollback could not finish. Original files are preserved in ${stage}; the safety backup is also available.`);
    }
    throw error;
  } finally { if (!preserve) await rm(stage, { recursive: true, force: true }); }
}

export async function deleteBackup(id: string, name: string) {
  if (/^snapshot-[a-f0-9]{64}$/.test(name)) { await deleteSnapshot(id, name); return; }
  if (!NAME.test(name)) throw new HttpError(400, "That backup doesn't exist.");
  await rm(path.join(backupDir(id), name), { recursive: true, force: true });
}
