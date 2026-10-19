import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DATA_ROOT, SERVERS_DIR, serverDir } from "./paths";
import { HttpError } from "./errors";
import { isActive } from "./minecraft";

export const MAX_TEXT_BYTES = 2 * 1024 ** 2;
export const MAX_UPLOAD_BYTES = 256 * 1024 ** 2;
export type FileEntry = { name: string; path: string; type: "file" | "directory"; size: number; modifiedAt: string; editable: boolean };
const TEXT = /\.(properties|json|ya?ml|toml|txt|log|conf|cfg|ini|md|mcmeta|csv|xml)$/i;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

export function cleanPath(value: string) {
  if (typeof value !== "string" || value.length > 1024) throw new HttpError(400, "Invalid file path.");
  const normalized = value.replaceAll("\\", "/");
  if (!normalized) return "";
  const segments = normalized.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part))) {
    throw new HttpError(400, "Use a relative path without reserved Windows names or special characters.");
  }
  return segments.join("/");
}

/** Files are managed only while stopped; plugins cannot race the path checks while running. */
export function assertFilesStopped(id: string) {
  if (isActive(id)) throw new HttpError(409, "Stop the server before managing its files.");
}

async function directoryRoot(id: string) {
  assertFilesStopped(id);
  await mkdir(DATA_ROOT, { recursive: true });
  for (const dir of [SERVERS_DIR, serverDir(id)]) {
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(400, "Server folders must be ordinary directories, not links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dir);
    }
  }
  return realpath(serverDir(id));
}

export async function safeTarget(id: string, requested: string, allowMissingLeaf = false) {
  const relative = cleanPath(requested);
  const root = await directoryRoot(id);
  const parts = relative ? relative.split("/") : [];
  let target = root;
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new HttpError(400, "Links and junctions cannot be managed from the panel.");
      if (index < parts.length - 1 && !info.isDirectory()) throw new HttpError(400, "The parent must be a directory.");
      const actual = await realpath(target);
      const inside = path.relative(root, actual);
      if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new HttpError(400, "Invalid file path.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf && index === parts.length - 1) continue;
      throw error;
    }
  }
  return { root, target, relative };
}

export async function listFiles(id: string, requested: string) {
  const { target, relative } = await safeTarget(id, requested);
  if (!(await lstat(target)).isDirectory()) throw new HttpError(400, "Choose a directory.");
  const entries: FileEntry[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    try {
      cleanPath(entry.name);
      const info = await lstat(path.join(target, entry.name));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
      entries.push({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name, type: info.isDirectory() ? "directory" : "file", size: info.size, modifiedAt: info.mtime.toISOString(), editable: info.isFile() && TEXT.test(entry.name) && info.size <= MAX_TEXT_BYTES });
    } catch { /* disappearing, unsupported, or reserved entry */ }
  }
  return entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
}

export async function readText(id: string, requested: string) {
  const { target } = await safeTarget(id, requested);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || !TEXT.test(target)) throw new HttpError(400, "Only text configuration files can be edited.");
    if (info.size > MAX_TEXT_BYTES) throw new HttpError(413, "Text files must be at most 2 MB.");
    const data = Buffer.alloc(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > MAX_TEXT_BYTES) throw new HttpError(413, "Text files must be at most 2 MB.");
    const content = data.subarray(0, bytesRead);
    if (content.includes(0)) throw new HttpError(400, "That is a binary file.");
    return { content: content.toString("utf8"), modifiedAt: info.mtime.toISOString(), revision: createHash("sha256").update(content).digest("hex") };
  } finally { await handle.close(); }
}

export async function openDownload(id: string, requested: string) {
  const { target } = await safeTarget(id, requested);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const info = await handle.stat();
  if (!info.isFile()) { await handle.close(); throw new HttpError(400, "Choose an ordinary file."); }
  return { handle, size: info.size, name: path.basename(target) };
}

export async function writeText(id: string, requested: string, content: string, modifiedAt?: string, revision?: string) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_TEXT_BYTES || content.includes("\0")) throw new HttpError(413, "Use a text file of at most 2 MB.");
  if (!TEXT.test(requested)) throw new HttpError(400, "Use a supported text file extension.");
  const { target, relative } = await safeTarget(id, requested, true);
  if (!relative) throw new HttpError(400, "Choose a file.");
  try {
    const info = await lstat(target);
    if (!modifiedAt && !revision) throw new HttpError(409, "That file already exists. Open it in the editor before replacing it.");
    if ((modifiedAt && info.mtime.toISOString() !== modifiedAt) || (revision && (await readText(id, requested)).revision !== revision)) throw new HttpError(409, "This file changed since you opened it. Reload it before saving.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (modifiedAt || revision) throw new HttpError(409, "This file was removed since you opened it. Reload the folder before saving.");
  }
  const temp = path.join(path.dirname(target), `.blocky-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx");
  try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
  try { await safeTarget(id, requested, true); await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}

export async function makeDirectory(id: string, requested: string) {
  const { target, relative } = await safeTarget(id, requested, true);
  if (!relative) throw new HttpError(400, "Choose a new folder name.");
  await mkdir(target);
}

export async function renameFile(id: string, requested: string, destination: string) {
  const source = await safeTarget(id, requested);
  const dest = await safeTarget(id, destination, true);
  if (!source.relative || !dest.relative) throw new HttpError(400, "The server root cannot be renamed.");
  try { await lstat(dest.target); throw new HttpError(409, "A file or folder already uses that name."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(source.target, dest.target);
}

export async function deleteFile(id: string, requested: string) {
  const { target, relative } = await safeTarget(id, requested);
  if (!relative) throw new HttpError(400, "The server root cannot be deleted.");
  await rm(target, { recursive: true });
}

export async function uploadFile(id: string, requested: string, req: IncomingMessage, maxBytes = MAX_UPLOAD_BYTES) {
  const { target, relative } = await safeTarget(id, requested, true);
  if (!relative) throw new HttpError(400, "Choose a filename.");
  // Uploads never replace existing files implicitly.
  try { await lstat(target); throw new HttpError(409, "That filename already exists. Rename or delete it first."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = path.join(path.dirname(target), `.blocky-${randomUUID()}.part`);
  const handle = await open(temp, "wx");
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, `Uploads must be at most ${Math.round(maxBytes / 1024 ** 2)} MB.`);
      await handle.writeFile(chunk);
    }
    await handle.close();
    await safeTarget(id, requested, true);
    await rename(temp, target);
  } finally { await handle.close(); await rm(temp, { force: true }); }
}
