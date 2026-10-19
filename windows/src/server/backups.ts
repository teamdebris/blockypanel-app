import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { backupDir, serverDir } from "./paths";
import { consoleLines, isActive, runtimeInfo, sendCommand } from "./minecraft";

/** Left out of backups: the server software, logs, and caches, which are downloaded or made again. */
const SKIP = new Set(["cache", "libraries", "versions", "logs", "crash-reports", ".paper-remapped"]);
// session.lock only marks a world as open; Windows keeps it locked while the server runs, so it can't be copied anyway.
const skip = (name: string) => SKIP.has(name) || name.endsWith(".jar") && !name.includes(path.sep) || name.endsWith(".part") || path.basename(name) === "session.lock";
const NAME = /^\d{8}-\d{6}(-[a-z]+)?$/;

export type Backup = { name: string; createdAt: string; sizeBytes: number; kind: "manual" | "safety" };

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await sizeOf(full) : (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function stamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => NAME.test(name)).sort().reverse();
  return Promise.all(names.map(async (name) => {
    const [date, time] = name.split("-");
    const createdAt = new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6)).toISOString();
    return { name, createdAt, sizeBytes: await sizeOf(path.join(dir, name)), kind: name.endsWith("-safety") ? "safety" as const : "manual" as const };
  }));
}

/** A copy of the server's folder. A running server saves and pauses writes first, so the copy is consistent. */
export async function createBackup(id: string, kind: Backup["kind"] = "manual") {
  const target = path.join(backupDir(id), `${stamp()}${kind === "safety" ? "-safety" : ""}`);
  const running = runtimeInfo(id).status === "running";
  if (running) {
    const since = Date.now();
    sendCommand(id, "save-off");
    sendCommand(id, "save-all flush");
    await waitForLine(id, /Saved the game|Saved the world|saved/i, since, 30_000);
  }
  try {
    await mkdir(target, { recursive: true });
    await cp(serverDir(id), target, { recursive: true, filter: (source) => !skip(path.relative(serverDir(id), source)) });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM") throw new Error(`A file in the server's folder is in use, so the backup couldn't be made: ${path.basename((error as NodeJS.ErrnoException).path ?? "")}. Try again, or stop the server first.`);
    if (code === "ENOSPC") throw new Error("There isn't enough disk space for the backup.");
    throw error;
  } finally {
    if (running) sendCommand(id, "save-on");
  }
  return path.basename(target);
}

/** Puts a backup back. The server must be stopped; a safety backup of the current files is taken first. */
export async function restoreBackup(id: string, name: string) {
  if (!NAME.test(name)) throw new Error("That backup doesn't exist.");
  if (isActive(id)) throw new Error("Stop the server before restoring a backup.");
  const source = path.join(backupDir(id), name);
  await stat(source).catch(() => { throw new Error("That backup doesn't exist."); });
  await createBackup(id, "safety");
  const dir = serverDir(id);
  for (const entry of await readdir(dir)) if (!skip(entry)) await rm(path.join(dir, entry), { recursive: true, force: true });
  await cp(source, dir, { recursive: true });
}

export async function deleteBackup(id: string, name: string) {
  if (!NAME.test(name)) throw new Error("That backup doesn't exist.");
  await rm(path.join(backupDir(id), name), { recursive: true, force: true });
}
