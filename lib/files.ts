import "server-only";

import { constants, createWriteStream } from "node:fs";
import { chmod, lchown, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { assertManagedServer } from "@/lib/docker";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { serverDataPath } from "@/lib/paths";
import { recordEvent } from "@/lib/store";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
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
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new BadRequestError("Invalid file path.");

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

/**
 * Re-checks, immediately before use, that a directory still resolves inside the server root. The
 * Minecraft container (and its plugins) can write to the same directory, so a path component could
 * be swapped for a symlink between the lstat walk above and the actual operation.
 */
async function assertContained(root: string, directory: string) {
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  const relation = path.relative(realRoot, realDirectory);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new BadRequestError("Invalid file path.");
}

function openError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") throw new BadRequestError("Symbolic links cannot be managed from the panel.");
  if (code === "ENOENT") throw new NotFoundError("File not found.");
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

  const { root, target } = await safeTarget(id, relative);
  await assertContained(root, target);
  if (!(await stat(target)).isDirectory()) throw new BadRequestError("The requested path is not a directory.");
  const entries = await readdir(target, { withFileTypes: true });
  const records = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry): Promise<ServerFileEntry | null> => {
    if (!entry.isDirectory() && !entry.isFile()) return null;
    const itemPath = childPath(relative, entry.name);
    const details = await lstat(path.join(target, entry.name)).catch(() => undefined);
    if (!details) return null;
    return { name: entry.name, path: itemPath, type: entry.isDirectory() ? "directory" : "file", size: entry.isFile() ? details.size : 0, modifiedAt: details.mtime.toISOString(), editable: entry.isFile() && details.size <= MAX_TEXT_BYTES };
  }));
  return records.filter((entry): entry is ServerFileEntry => Boolean(entry)).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
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
    const { root, target } = await safeTarget(id, relative);
    await assertContained(root, path.dirname(target));
    const handle = await open(target, constants.O_RDONLY | NOFOLLOW).catch(openError);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new BadRequestError("The requested path is not a file.");
      if (details.size > MAX_TEXT_BYTES) throw new BadRequestError("Files larger than 2 MB can be downloaded but not edited in the browser.");
      content = await handle.readFile();
    } finally { await handle.close(); }
  }
  if (!isProbablyText(content)) throw new BadRequestError("This appears to be a binary file. Download it instead.");
  return content.toString("utf8");
}

/** Opens a file for download. The caller owns the returned handle; streaming it closes it automatically. */
export async function serverFileForDownload(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Select a file first.");
  if (process.env.BLOCKY_DEMO === "true") throw new BadRequestError("File downloads require a real Docker host.");
  const { root, target } = await safeTarget(id, relative);
  await assertContained(root, path.dirname(target));
  const handle = await open(target, constants.O_RDONLY | NOFOLLOW).catch(openError);
  const details = await handle.stat();
  if (!details.isFile()) { await handle.close(); throw new BadRequestError("The requested path is not a file."); }
  return { handle, name: path.basename(target), size: details.size };
}

export async function createServerDirectory(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Enter a directory name.");
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    if (nodes.has(relative)) throw new BadRequestError("A file or directory with that name already exists.");
    nodes.set(relative, { type: "directory", modifiedAt: new Date().toISOString() });
  } else {
    const { root, target } = await safeTarget(id, relative, true);
    await assertContained(root, path.dirname(target));
    await mkdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new BadRequestError("A file or directory with that name already exists.");
      if (error.code === "ENOENT") throw new BadRequestError("Parent directory not found.");
      throw error;
    });
    // lchown: the game container can write here, so never follow a link it might have planted.
    await lchown(target, 1000, 1000).catch(() => undefined);
    await chmod(target, 0o770).catch(() => undefined);
  }
  await recordEvent(id, "file-create", `Directory ${relative} was created.`, "info");
}

export async function writeServerTextFile(id: string, requested: string, content: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Enter a file name.");
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new BadRequestError("Text files are limited to 2 MB.");
  if (process.env.BLOCKY_DEMO === "true") demoFiles(id).set(relative, { type: "file", content: Buffer.from(content), modifiedAt: new Date().toISOString() });
  else {
    const { root, target } = await safeTarget(id, relative, true);
    const parent = path.dirname(target);
    if (!(await stat(parent).catch(() => undefined))?.isDirectory()) throw new BadRequestError("Parent directory not found.");
    await assertContained(root, parent);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o660).catch(openError);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chown(1000, 1000).catch(() => undefined);
    } finally { await handle.close(); }
  }
  await recordEvent(id, "file-write", `File ${relative} was saved.`, "info");
}

export async function uploadServerFile(id: string, requested: string, body: ReadableStream<Uint8Array>) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("Choose a file to upload.");
  if (process.env.BLOCKY_DEMO === "true") {
    const chunks: Buffer[] = [];
    for await (const chunk of webStreamChunks(body)) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks);
    if (content.length > MAX_UPLOAD_BYTES) throw new BadRequestError("Uploads are limited to 512 MB.");
    demoFiles(id).set(relative, { type: "file", content, modifiedAt: new Date().toISOString() });
  } else {
    const { root, target } = await safeTarget(id, relative, true);
    const parent = path.dirname(target);
    if (!(await stat(parent).catch(() => undefined))?.isDirectory()) throw new BadRequestError("Parent directory not found.");
    if ((await lstat(target).catch(() => undefined))?.isDirectory()) throw new BadRequestError("A directory with that name already exists.");
    await assertContained(root, parent);
    const temporary = path.join(parent, `.blocky-upload-${randomUUID()}`);
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > MAX_UPLOAD_BYTES ? new BadRequestError("Uploads are limited to 512 MB.") : null, chunk); } });
    try {
      await pipeline(Readable.from(webStreamChunks(body)), limiter, createWriteStream(temporary, { flags: "wx", mode: 0o660 }));
      // Ownership is set on our own temp file, then rename() replaces whatever is at the target
      // (even a symlink) without following it. Changing the target afterwards could follow a link.
      await lchown(temporary, 1000, 1000).catch(() => undefined);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
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
    const { root, target: sourcePath } = await safeTarget(id, source);
    const { target: destinationPath } = await safeTarget(id, destination, true);
    if (await lstat(destinationPath).catch(() => undefined)) throw new BadRequestError("A file or directory with that name already exists.");
    if (!(await stat(path.dirname(destinationPath)).catch(() => undefined))?.isDirectory()) throw new BadRequestError("Destination folder not found.");
    await assertContained(root, path.dirname(sourcePath));
    await assertContained(root, path.dirname(destinationPath));
    await rename(sourcePath, destinationPath);
  }
  await recordEvent(id, "file-rename", `${source} was renamed to ${destination}.`, "info");
}

export async function deleteServerFile(id: string, requested: string) {
  const relative = cleanRelativePath(requested);
  if (!relative) throw new BadRequestError("The server data root cannot be deleted.");
  if (process.env.BLOCKY_DEMO === "true") {
    const nodes = demoFiles(id);
    if (!nodes.has(relative)) throw new NotFoundError("File not found.");
    for (const key of [...nodes.keys()]) if (key === relative || key.startsWith(`${relative}/`)) nodes.delete(key);
  } else {
    const { root, target } = await safeTarget(id, relative);
    await assertContained(root, path.dirname(target));
    await rm(target, { recursive: true, force: false });
  }
  await recordEvent(id, "file-delete", `${relative} was deleted.`, "warning");
}

