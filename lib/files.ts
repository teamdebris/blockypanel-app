import "server-only";

import { constants, createWriteStream } from "node:fs";
import { lchown, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { anchorDirectory, anchorParent, insideRoot, removeAnchored } from "@/lib/anchored-paths";
import { extractArchive } from "@/lib/archive";
import { assertManagedServer } from "@/lib/docker";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { serverDataPath, serverRootPath, storagePath } from "@/lib/paths";
import { recordEvent } from "@/lib/store";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// Worlds are often over a gigabyte; 4 GB is also where plain (non-zip64) zip files top out.
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
// The demo keeps files in memory and its accounts are public, so it holds only a little.
const DEMO_MAX_FILES = 200;
const DEMO_MAX_TOTAL_BYTES = 32 * 1024 ** 2;
const DEMO_MAX_UPLOAD_BYTES = 8 * 1024 ** 2;
export const ARCHIVE_NAME = /\.(zip|tar|tar\.gz|tgz)$/i;
// Not defined on Windows, where the dev server may run; symlink swaps are a Linux-host concern.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type ServerFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  editable: boolean;
};

type DemoNode = { type: "file" | "directory"; content?: Buffer; modifiedAt: string };
const demoGlobal = globalThis as typeof globalThis & { __blockyDemoFiles?: Record<string, Map<string, DemoNode>> };

function cleanRelativePath(value = "") {
  if (value.includes("\u0000") || value.length > 1024) throw new BadRequestError("Invalid file path.");
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new BadRequestError("Invalid file path.");
  return segments.join("/");
}

function childPath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

function demoFiles(id: string) {
  demoGlobal.__blockyDemoFiles ??= {};
  if (!demoGlobal.__blockyDemoFiles[id]) {
    const now = new Date().toISOString();
    demoGlobal.__blockyDemoFiles[id] = new Map<string, DemoNode>([
      ["world", { type: "directory", modifiedAt: now }],
      ["plugins", { type: "directory", modifiedAt: now }],
      ["logs", { type: "directory", modifiedAt: now }],
      ["server.properties", { type: "file", content: Buffer.from("motd=Team Blocky Minecraft Server\ndifficulty=normal\nmax-players=20\n"), modifiedAt: now }],
      ["whitelist.json", { type: "file", content: Buffer.from("[]\n"), modifiedAt: now }],
      ["ops.json", { type: "file", content: Buffer.from("[]\n"), modifiedAt: now }],
      ["logs/latest.log", { type: "file", content: Buffer.from("[Server thread/INFO]: Done!\n"), modifiedAt: now }],
    ]);
  }
  return demoGlobal.__blockyDemoFiles[id];
}

/** Refuses a demo write that would take the in-memory files past their budget. */
function assertDemoBudget(nodes: Map<string, DemoNode>, relative: string, bytes: number) {
  let files = 0;
  let total = 0;
  for (const [key, node] of nodes) { if (key !== relative) { files += 1; total += node.content?.length || 0; } }
  if (files + 1 > DEMO_MAX_FILES) throw new BadRequestError(`The demo keeps at most ${DEMO_MAX_FILES} files per server.`);
  if (total + bytes > DEMO_MAX_TOTAL_BYTES) throw new BadRequestError(`The demo keeps at most ${DEMO_MAX_TOTAL_BYTES / 1024 ** 2} MB of files per server.`);
}

async function rootFor(id: string) {
  await assertManagedServer(id);
  const root = serverDataPath(id);
  await mkdir(root, { recursive: true });
  return root;
}

async function safeTarget(id: string, requested: string, allowMissing = false) {
  const relative = cleanRelativePath(requested);
  const root = await rootFor(id);
  const target = path.resolve(root, ...relative.split("/").filter(Boolean));
  if (!insideRoot(root, target)) throw new BadRequestError("Invalid file path.");

  let current = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new BadRequestError("Symbolic links cannot be managed from the panel.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (allowMissing) break;
        throw new NotFoundError("File not found.");
      }
      throw error;
    }
  }
  return { root, target, relative };
}

function openError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") throw new BadRequestError("Symbolic links cannot be managed from the panel.");
  if (code === "ENOENT") throw new NotFoundError("File not found.");
  if (code === "ENOTDIR") throw new BadRequestError("The requested path is not a directory.");
  if (code === "EISDIR") throw new BadRequestError("The requested path is a directory.");
  throw error;
}

function isProbablyText(buffer: Buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

async function* webStreamChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield Buffer.from(result.value);
    }
  } finally { reader.releaseLock(); }
}

export async function listServerFiles(id: string, requested = "") {
  await assertManagedServer(id);
  const relative = cleanRelativePath(requested);
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    const prefix = relative ? `${relative}/` : "";
    const entries: ServerFileEntry[] = [];
    for (const [itemPath, node] of nodes) {
      if (!itemPath.startsWith(prefix)) continue;
      const remainder = itemPath.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      entries.push({ name: remainder, path: itemPath, type: node.type, size: node.content?.length || 0, modifiedAt: node.modifiedAt, editable: node.type === "file" && (node.content?.length || 0) <= MAX_TEXT_BYTES });
    }
    return entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  }

  const { root } = await safeTarget(id, relative);
  const directory = await anchorDirectory(root, relative).catch(openError);
  try {
    const entries = await readdir(directory.path, { withFileTypes: true });
    const records = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry): Promise<ServerFileEntry | null> => {
      if (!entry.isDirectory() && !entry.isFile()) return null;
      const itemPath = childPath(relative, entry.name);
      const details = await lstat(path.join(directory.path, entry.name)).catch(() => undefined);
      if (!details || details.isSymbolicLink()) return null;
      return { name: entry.name, path: itemPath, type: details.isDirectory() ? "directory" : "file", size: details.isFile() ? details.size : 0, modifiedAt: details.mtime.toISOString(), editable: details.isFile() && details.size <= MAX_TEXT_BYTES };
    }));
    return records.filter((entry): entry is ServerFileEntry => Boolean(entry)).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  } finally { await directory.close(); }
}

export async function readServerTextFile(id: string, requested: string) {
  await assertManagedServer(id);
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Select a file first.");
  let content: Buffer;
  if (process.env.BLOCKY_DEMO === "true") {
    const node = demoFiles(id).get(relative);
    if (!node || node.type !== "file") throw new NotFoundError("File not found.");
    content = node.content || Buffer.alloc(0);
  } else {
    const { root } = await safeTarget(id, relative);
    const parent = await anchorParent(root, relative).catch(openError);
    try {
      const handle = await open(path.join(parent.path, parent.name), constants.O_RDONLY | NOFOLLOW).catch(openError);
      try {
        const details = await handle.stat();
        if (!details.isFile()) throw new BadRequestError("The requested path is not a file.");
        if (details.size > MAX_TEXT_BYTES) throw new BadRequestError("Files larger than 2 MB can be downloaded but not edited in the browser.");
        content = await handle.readFile();
      } finally { await handle.close(); }
    } finally { await parent.close(); }
  }
  if (!isProbablyText(content)) throw new BadRequestError("This appears to be a binary file. Download it instead.");
  return content.toString("utf8");
}

/** Opens a file for download. The caller owns the returned handle; streaming it closes it automatically. */
export async function serverFileForDownload(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Select a file first.");
  if (process.env.BLOCKY_DEMO === "true") throw new BadRequestError("File downloads require a real Docker host.");
  const { root } = await safeTarget(id, relative);
  const parent = await anchorParent(root, relative).catch(openError);
  try {
    const handle = await open(path.join(parent.path, parent.name), constants.O_RDONLY | NOFOLLOW).catch(openError);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new BadRequestError("The requested path is not a file.");
      return { handle, name: parent.name, size: details.size };
    } catch (error) { await handle.close(); throw error; }
  } finally { await parent.close(); }
}

export async function createServerDirectory(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Enter a directory name.");
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    if (nodes.has(relative)) throw new BadRequestError("A file or directory with that name already exists.");
    assertDemoBudget(nodes, relative, 0);
    nodes.set(relative, { type: "directory", modifiedAt: new Date().toISOString() });
  } else {
    const { root } = await safeTarget(id, relative, true);
    const parent = await anchorParent(root, relative).catch(openError);
    try {
      const target = path.join(parent.path, parent.name);
      await mkdir(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new BadRequestError("A file or directory with that name already exists.");
        if (error.code === "ENOENT") throw new BadRequestError("Parent directory not found.");
        throw error;
      });
      // Use the newly opened inode for ownership and permissions; chmod(path) follows a swapped link.
      const created = await open(target, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW).catch(openError);
      try {
        await created.chown(1000, 1000).catch(() => undefined);
        await created.chmod(0o770).catch(() => undefined);
      } finally { await created.close(); }
    } finally { await parent.close(); }
  }
  await recordEvent(id, "file-create", `Directory ${relative} was created.`, "info");
}

export async function writeServerTextFile(id: string, requested: string, content: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Enter a file name.");
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new BadRequestError("Text files are limited to 2 MB.");
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    assertDemoBudget(nodes, relative, Buffer.byteLength(content));
    nodes.set(relative, { type: "file", content: Buffer.from(content), modifiedAt: new Date().toISOString() });
  } else {
    const { root } = await safeTarget(id, relative, true);
    const parent = await anchorParent(root, relative).catch(openError);
    try {
      const handle = await open(path.join(parent.path, parent.name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o660).catch(openError);
      try {
        await handle.writeFile(content, "utf8");
        await handle.chown(1000, 1000).catch(() => undefined);
      } finally { await handle.close(); }
    } finally { await parent.close(); }
  }
  await recordEvent(id, "file-write", `File ${relative} was saved.`, "info");
}

/** An upload that ended at a different length than the browser announced: never keep a partial file. */
function sizeMismatch(received: number, expected: number) {
  return new BadRequestError(received < expected
    ? `The upload was cut short (${received} of ${expected} bytes arrived). Nothing was saved; try again.`
    : `The upload was longer than expected (${received} bytes, not ${expected}). Nothing was saved.`);
}

export async function uploadServerFile(id: string, requested: string, body: ReadableStream<Uint8Array>, expectedBytes: number) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Choose a file to upload.");
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    assertDemoBudget(nodes, relative, 0);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of webStreamChunks(body)) {
      bytes += chunk.length;
      // Checked as it arrives: the demo buffers uploads in memory, so it stops early instead of after 4 GB.
      if (bytes > DEMO_MAX_UPLOAD_BYTES) throw new BadRequestError(`Demo uploads are limited to ${DEMO_MAX_UPLOAD_BYTES / 1024 ** 2} MB.`);
      chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks);
    if (content.length !== expectedBytes) throw sizeMismatch(content.length, expectedBytes);
    assertDemoBudget(nodes, relative, content.length);
    nodes.set(relative, { type: "file", content, modifiedAt: new Date().toISOString() });
  } else {
    const { root } = await safeTarget(id, relative, true);
    const parent = await anchorParent(root, relative).catch(openError);
    try {
      const target = path.join(parent.path, parent.name);
      if ((await lstat(target).catch(() => undefined))?.isDirectory()) throw new BadRequestError("A directory with that name already exists.");
      const temporary = path.join(parent.path, `.blocky-upload-${randomUUID()}`);
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > MAX_UPLOAD_BYTES ? new BadRequestError("Uploads are limited to 4 GB.") : null, chunk); } });
      try {
        await pipeline(Readable.from(webStreamChunks(body)), limiter, createWriteStream(temporary, { flags: "wx", mode: 0o660 }));
        if (bytes !== expectedBytes) throw sizeMismatch(bytes, expectedBytes);
        // rename replaces a final symlink without following it; the parent stays pinned throughout.
        await lchown(temporary, 1000, 1000).catch(() => undefined);
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    } finally { await parent.close(); }
  }
  await recordEvent(id, "file-upload", `File ${relative} was uploaded.`, "info");
}

/** Renames or moves an entry within the server's data directory. Refuses to overwrite an existing entry. */
export async function renameServerFile(id: string, from: string, to: string) {
  const source = cleanRelativePath(from);
  const destination = cleanRelativePath(to);
  if (!source || !destination) throw new BadRequestError("Choose a file and a new name.");
  if (source === destination) return;
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    if (!nodes.has(source)) throw new NotFoundError("File not found.");
    if (nodes.has(destination)) throw new BadRequestError("A file or directory with that name already exists.");
    for (const [key, node] of [...nodes]) {
      if (key !== source && !key.startsWith(`${source}/`)) continue;
      nodes.delete(key);
      nodes.set(destination + key.slice(source.length), node);
    }
  } else {
    const { root } = await safeTarget(id, source);
    await safeTarget(id, destination, true);
    const fromParent = await anchorParent(root, source).catch(openError);
    try {
      const toParent = await anchorParent(root, destination).catch(openError);
      try {
        const sourcePath = path.join(fromParent.path, fromParent.name);
        const destinationPath = path.join(toParent.path, toParent.name);
        if (await lstat(destinationPath).catch(() => undefined)) throw new BadRequestError("A file or directory with that name already exists.");
        await rename(sourcePath, destinationPath);
      } finally { await toParent.close(); }
    } finally { await fromParent.close(); }
  }
  await recordEvent(id, "file-rename", `${source} was renamed to ${destination}.`, "info");
}

/** Archive errors are the uploader's to fix (a bad or hostile file), so they're shown as such. */
export function archiveProblem(error: unknown): never {
  if (error instanceof Error && error.name === "ArchiveError") throw new BadRequestError(error.message);
  throw error;
}

/** An archive in a server's data folder, checked like any other path the panel touches. */
export async function serverArchivePath(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!ARCHIVE_NAME.test(relative)) throw new BadRequestError("Choose a .zip, .tar, or .tar.gz file.");
  const { root } = await safeTarget(id, relative);
  const parent = await anchorParent(root, relative).catch(openError);
  try {
    const handle = await open(path.join(parent.path, parent.name), constants.O_RDONLY | NOFOLLOW).catch(openError);
    try {
      if (!(await handle.stat()).isFile()) throw new BadRequestError("That isn't a file.");
      // The archive reader opens its input repeatedly. /proc/self/fd keeps every read on this
      // already checked inode even if the game replaces the archive's name while it is extracted.
      const target = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path.join(parent.path, parent.name);
      return { target, parent: parent.path, relative, close: async () => { try { await handle.close(); } finally { await parent.close(); } } };
    } catch (error) { await handle.close(); throw error; }
  } catch (error) { await parent.close(); throw error; }
}

/** Stage outside data/ so the game cannot rename this tree while it is being prepared. */
export async function chownTree(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await chownTree(full);
    else if (entry.isFile()) await lchown(full, 1000, 1000).catch(() => undefined);
  }
  await lchown(directory, 1000, 1000).catch(() => undefined);
}

/**
 * Unpacks an archive into the folder it's in. It's extracted into a fresh hidden folder first, so a
 * hostile archive can't touch existing files; then, if nothing it contains already exists here, its
 * contents are moved into place.
 */
export async function extractServerArchive(id: string, requested: string) {
  if (process.env.BLOCKY_DEMO === "true") throw new BadRequestError("Extracting requires a real Docker host.");
  const archive = await serverArchivePath(id, requested);
  const { target, relative, parent } = archive;
  const staging = storagePath(serverRootPath(id), `.blocky-extract-${randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    const result = await extractArchive(target, staging).catch(archiveProblem);
    const names = await readdir(staging);
    const existing: string[] = [];
    for (const name of names) if (await lstat(path.join(parent, name)).catch(() => undefined)) existing.push(name);
    if (existing.length) throw new BadRequestError(`These are already here: ${existing.slice(0, 5).join(", ")}${existing.length > 5 ? ", …" : ""}. Rename or delete them first.`);
    await chownTree(staging);
    for (const name of names) await rename(path.join(staging, name), path.join(parent, name));
    await recordEvent(id, "file-extract", `${relative} was extracted (${result.files} file${result.files === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} links or special files skipped` : ""}).`, "info");
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await archive.close();
  }
}

export async function deleteServerFile(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("The server data root cannot be deleted.");
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    if (!nodes.has(relative)) throw new NotFoundError("File not found.");
    for (const key of [...nodes.keys()]) if (key === relative || key.startsWith(`${relative}/`)) nodes.delete(key);
  } else {
    const { root } = await safeTarget(id, relative);
    const parent = await anchorParent(root, relative).catch(openError);
    // Deleted through the held parent and each subdirectory's own descriptor (see removeAnchored).
    try { await removeAnchored(parent.path, parent.name).catch(openError); }
    finally { await parent.close(); }
  }
  await recordEvent(id, "file-delete", `${relative} was deleted.`, "warning");
}

