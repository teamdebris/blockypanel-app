import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractArchive, listArchive } from "../../../lib/archive";
import { MAX_STDOUT_BYTES, outputCollector } from "../../../lib/output-limit";
import { download } from "./download";
import { cleanPath } from "./files";
import { DATA_ROOT, RUNTIME_DIR, backupDir, serverDir } from "./paths";

const VERSION = "0.19.1";
const ZIP_SHA256 = "da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d";
const SNAPSHOT = /^snapshot-([a-f0-9]{64})$/;
export type Snapshot = { id: string; time: string; paths: string[]; tags?: string[]; summary?: { total_bytes_processed?: number; data_added_packed?: number } };
let installing: Promise<string> | undefined;

async function installRestic() {
  if (process.env.BLOCKY_RESTIC_BINARY) return process.env.BLOCKY_RESTIC_BINARY;
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The automatic restic download supports Windows x64. Set BLOCKY_RESTIC_BINARY for another platform.");
  const root = path.join(RUNTIME_DIR, `restic-${VERSION}`);
  const binary = path.join(root, "restic.exe");
  const existing = await lstat(binary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (existing?.isFile() && !existing.isSymbolicLink()) return binary;
  await mkdir(RUNTIME_DIR, { recursive: true });
  if ((await lstat(RUNTIME_DIR)).isSymbolicLink()) throw new Error("The runtime folder cannot be a link or junction.");
  const staging = path.join(RUNTIME_DIR, `restic-install-${randomUUID()}`);
  await mkdir(staging);
  try {
    const archive = path.join(staging, "restic.zip");
    await download(`https://github.com/restic/restic/releases/download/v${VERSION}/restic_${VERSION}_windows_amd64.zip`, archive, { sha256: ZIP_SHA256, maxBytes: 64 * 1024 ** 2, allowedHosts: ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"] });
    const limits = { maxEntries: 20, maxTotalBytes: 128 * 1024 ** 2 };
    const listing = await listArchive(archive, limits);
    for (const entry of listing.entries) cleanPath(entry.path);
    const exe = listing.entries.find((entry) => entry.type === "file" && !entry.path.includes("/") && /^restic.*\.exe$/i.test(entry.path));
    if (!exe) throw new Error("The restic archive did not contain its executable.");
    const extracted = path.join(staging, "extracted"); await mkdir(extracted);
    await extractArchive(archive, extracted, { limits, freeSpaceMargin: 64 * 1024 ** 2 });
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new Error("The restic folder cannot be a link or junction.");
    await rename(path.join(extracted, exe.path), binary);
    return binary;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export function ensureRestic() {
  installing ??= installRestic().catch((error) => { installing = undefined; throw error; });
  return installing;
}

type Run = { repository: string; password: string; env?: Record<string, string>; from?: { repository: string; password: string }; signal?: AbortSignal; stdin?: string };
const children = new Set<ChildProcessWithoutNullStreams>();
let closing = false;
export async function runRestic(args: string[], options: Run): Promise<string> {
  if (closing) throw new Error("The panel is shutting down.");
  const binary = await ensureRestic();
  if (closing) throw new Error("The panel is shutting down.");
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, RESTIC_REPOSITORY: options.repository, RESTIC_PASSWORD: options.password, RESTIC_CACHE_DIR: path.join(DATA_ROOT, "cache", "restic") };
  delete env.RESTIC_PASSWORD_FILE; delete env.RESTIC_REPOSITORY_FILE; delete env.RESTIC_FROM_PASSWORD_FILE;
  delete env.RESTIC_FROM_REPOSITORY; delete env.RESTIC_FROM_PASSWORD;
  if (options.from) { env.RESTIC_FROM_REPOSITORY = options.from.repository; env.RESTIC_FROM_PASSWORD = options.from.password; }
  const signal = AbortSignal.any([AbortSignal.timeout(2 * 60 * 60000), ...(options.signal ? [options.signal] : [])]);
  const child = spawn(binary, ["--retry-lock", "30s", ...args], { env, signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  const stdout = outputCollector(MAX_STDOUT_BYTES, () => child.kill());
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.stdin.on("error", () => undefined); child.stdin.end(options.stdin || "");
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (stdout.overflowed) reject(new Error("restic returned too much output, so it was stopped."));
        else if (code === 0) resolve(stdout.text());
        else reject(Object.assign(new Error(`Restic backup operation failed: ${stderr.trim() || `exit ${code}`}`), { code }));
      });
    });
  } finally { children.delete(child); }
}
export function stopRestic() { closing = true; for (const child of children) child.kill(); }

export async function localRepository(id: string, initialize = false) {
  const root = backupDir(id);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("The backup folder cannot be a link or junction.");
  const repository = path.join(root, "restic");
  const repositoryInfo = await lstat(repository).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (repositoryInfo && (!repositoryInfo.isDirectory() || repositoryInfo.isSymbolicLink())) throw new Error("The backup repository must be an ordinary directory.");
  const passwordFile = path.join(root, "restic-password");
  const config = await lstat(path.join(repository, "config")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  let password: string;
  try {
    const info = await lstat(passwordFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("The backup password must be an ordinary file.");
    password = (await readFile(passwordFile, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (config) throw new Error("The encrypted backup password is missing. Restore restic-password from a copy of your Blocky data folder; a new password cannot unlock the existing snapshots.");
    if (!initialize) return undefined;
    password = randomBytes(32).toString("hex");
    await writeFile(passwordFile, `${password}\n`, { flag: "wx", mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("The backup password file is invalid. Restore a valid copy before continuing.");
  if (!config && !initialize) return undefined;
  if (config && ((await lstat(repository)).isSymbolicLink() || !config.isFile() || config.isSymbolicLink())) throw new Error("The backup repository cannot contain links in its root.");
  const options = { repository, password };
  if (!config) await runRestic(["init", "--repository-version", "2"], options);
  return options;
}

export async function listSnapshots(id: string): Promise<Snapshot[]> {
  const options = await localRepository(id);
  if (!options) return [];
  const result = JSON.parse(await runRestic(["snapshots", "--json"], options)) as Snapshot[] | null;
  return (result || []).filter((snapshot) => /^[a-f0-9]{64}$/.test(snapshot.id) && snapshot.paths.length === 1).sort((a, b) => b.time.localeCompare(a.time));
}
export async function createSnapshot(id: string, kind: "manual" | "safety" | "scheduled") {
  const options = (await localRepository(id, true))!;
  const root = serverDir(id);
  const exclude = ["cache", "libraries", "versions", "logs", "crash-reports", ".paper-remapped", ".blocky-uploads", "*.jar"].flatMap((name) => ["--exclude", path.join(root, name).replaceAll("\\", "/")]);
  const lines = await runRestic(["backup", "--json", "--quiet", "--tag", `kind:${kind}`, ...exclude, root], options);
  const summary = lines.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.message_type === "summary");
  if (!summary?.snapshot_id || !/^[a-f0-9]{64}$/.test(summary.snapshot_id)) throw new Error("restic did not return a completed snapshot.");
  return `snapshot-${summary.snapshot_id}`;
}
export async function getSnapshot(id: string, name: string) {
  const match = SNAPSHOT.exec(name);
  if (!match) throw new Error("Invalid snapshot name.");
  const snapshot = (await listSnapshots(id)).find((snapshot) => snapshot.id === match[1]);
  if (!snapshot) throw new Error("That snapshot does not exist.");
  return snapshot;
}
export async function restoreSnapshot(id: string, name: string, destination: string) {
  const options = (await localRepository(id))!;
  const snapshot = await getSnapshot(id, name);
  const inside = snapshot.paths[0].replace(/^([A-Za-z]):[\\/]/, "/$1/").replaceAll("\\", "/");
  await runRestic(["restore", `${snapshot.id}:${inside}`, "--target", destination, "--verify"], options);
}
export async function deleteSnapshot(id: string, name: string) {
  const snapshot = await getSnapshot(id, name);
  await runRestic(["forget", snapshot.id, "--quiet"], (await localRepository(id))!);
}
export async function maintainRepository(id: string, prune: boolean) {
  const options = await localRepository(id);
  if (!options) throw new Error("Create an incremental backup first.");
  await runRestic(prune ? ["prune", "--quiet", "--max-unused", "10%"] : ["check"], options);
}
