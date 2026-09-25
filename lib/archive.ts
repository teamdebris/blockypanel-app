import { constants, createReadStream } from "node:fs";
import { mkdir, open, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { createGunzip, createInflateRaw, crc32 } from "node:zlib";

/**
 * Reads and safely extracts .zip, .tar, and .tar.gz archives (worlds, plugin configs). No Next.js
 * imports, so it's tested directly. Extraction only ever writes into a fresh, empty directory the
 * caller made; the caller moves things into place afterwards.
 *
 * Refused outright: absolute paths, ".." segments, encrypted zip entries, duplicate paths, and
 * archives over the size or entry limits. Skipped (counted): symlinks, hard links, and device files.
 */

export class ArchiveError extends Error {
  constructor(message: string) { super(message); this.name = "ArchiveError"; }
}

export type ArchiveEntry = { path: string; type: "file" | "directory"; size: number };
export type ArchiveLimits = { maxEntries: number; maxTotalBytes: number };
export const DEFAULT_LIMITS: ArchiveLimits = { maxEntries: 200_000, maxTotalBytes: 64 * 1024 ** 3 };

// Not defined on Windows, where the dev server may run.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A clean relative path for an entry, or throws for anything that could escape the destination. */
export function safeEntryPath(raw: string) {
  const normalized = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!normalized || normalized.includes("\0")) throw new ArchiveError("The archive has an entry with an invalid name.");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw new ArchiveError(`The archive has an absolute path (${raw.slice(0, 80)}), which isn't allowed.`);
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw new ArchiveError(`The archive has a path that points outside it (${raw.slice(0, 80)}).`);
  return segments.join("/");
}

type Visit = (entry: ArchiveEntry, content: () => AsyncIterable<Buffer>) => Promise<void>;

async function kindOf(file: string) {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(512);
    const { bytesRead } = await handle.read(head, 0, 512, 0);
    if (bytesRead >= 4 && head.readUInt32LE(0) === 0x04034b50) return "zip";
    if (bytesRead >= 4 && head.readUInt32LE(0) === 0x06054b50) return "zip";
    if (bytesRead >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "tar.gz";
    if (bytesRead >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  } finally { await handle.close(); }
  throw new ArchiveError("That isn't a .zip, .tar, or .tar.gz archive.");
}

// ---- zip ----

type ZipEntry = { name: string; method: number; flags: number; crc: number; compressedSize: number; size: number; offset: number; externalAttributes: number; madeBy: number };

async function zipDirectory(file: string, limits: ArchiveLimits): Promise<ZipEntry[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let index = tailSize - 22; index >= 0; index -= 1) if (tail.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
    if (eocd === -1) throw new ArchiveError("The zip file is damaged or incomplete (no directory at the end).");
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      // zip64: the locator sits just before the classic record and points at the zip64 record.
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new ArchiveError("The zip file is damaged (missing zip64 locator).");
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)));
      if (record.readUInt32LE(0) !== 0x06064b50) throw new ArchiveError("The zip file is damaged (bad zip64 record).");
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (count > limits.maxEntries) throw new ArchiveError(`The archive has ${count} entries; the limit is ${limits.maxEntries}.`);
    if (directoryOffset + directorySize > size) throw new ArchiveError("The zip file is damaged or incomplete.");
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    let position = 0;
    for (let index = 0; index < count; index += 1) {
      if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) throw new ArchiveError("The zip file's directory is damaged.");
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const entry: ZipEntry = {
        madeBy: directory.readUInt16LE(position + 4) >> 8,
        flags: directory.readUInt16LE(position + 8),
        method: directory.readUInt16LE(position + 10),
        crc: directory.readUInt32LE(position + 16),
        compressedSize: directory.readUInt32LE(position + 20),
        size: directory.readUInt32LE(position + 24),
        externalAttributes: directory.readUInt32LE(position + 38),
        offset: directory.readUInt32LE(position + 42),
        name: directory.subarray(position + 46, position + 46 + nameLength).toString("utf8"),
      };
      // zip64 sizes and offsets live in extra field 0x0001, in this order, only for maxed-out fields.
      let extra = position + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          const next = () => { const value = Number(directory.readBigUInt64LE(field)); field += 8; return value; };
          if (entry.size === 0xffffffff) entry.size = next();
          if (entry.compressedSize === 0xffffffff) entry.compressedSize = next();
          if (entry.offset === 0xffffffff) entry.offset = next();
        }
        extra += 4 + length;
      }
      entries.push(entry);
      position = extraEnd + commentLength;
    }
    return entries;
  } finally { await handle.close(); }
}

function zipEntryKind(entry: ZipEntry): ArchiveEntry["type"] | "skip" {
  const unixMode = entry.madeBy === 3 ? entry.externalAttributes >>> 16 : 0;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) return "skip"; // symlink
  if (fileType && fileType !== 0o100000 && fileType !== 0o040000) return "skip"; // device, fifo, socket
  return entry.name.endsWith("/") || fileType === 0o040000 ? "directory" : "file";
}

async function visitZip(file: string, limits: ArchiveLimits, visit: Visit) {
  let skipped = 0;
  for (const entry of await zipDirectory(file, limits)) {
    const type = zipEntryKind(entry);
    if (type === "skip") { skipped += 1; continue; }
    if (entry.flags & 1) throw new ArchiveError("The archive is password-protected, which isn't supported.");
    if (type === "file" && entry.method !== 0 && entry.method !== 8) throw new ArchiveError(`${entry.name} uses a compression method that isn't supported (only stored and deflate are).`);
    const entryPath = safeEntryPath(entry.name);
    if (!entryPath) continue;
    await visit({ path: entryPath, type, size: type === "file" ? entry.size : 0 }, () => zipContent(file, entry));
  }
  return skipped;
}

async function* zipContent(file: string, entry: ZipEntry): AsyncIterable<Buffer> {
  const header = Buffer.alloc(30);
  const handle = await open(file, "r");
  try { await handle.read(header, 0, 30, entry.offset); } finally { await handle.close(); }
  if (header.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError(`${entry.name} is damaged in the zip file.`);
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (entry.compressedSize === 0) { if (entry.size) throw new ArchiveError(`${entry.name} is damaged in the zip file.`); return; }
  const raw = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  const source = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  let crc = 0;
  let written = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      written += chunk.length;
      // A zip bomb can claim a small size; the declared size is what the limits were checked against.
      if (written > entry.size) throw new ArchiveError(`${entry.name} is larger than the zip file says.`);
      crc = crc32(chunk, crc);
      yield chunk;
    }
  } finally { raw.destroy(); }
  if (written !== entry.size || crc !== entry.crc) throw new ArchiveError(`${entry.name} is damaged in the zip file (checksum mismatch).`);
}

// ---- tar ----

/** Pulls exact byte counts out of a stream of chunks. */
class ChunkReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly source: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) { this.source = source[Symbol.asyncIterator](); }

  private async pull() {
    const next = await this.source.next();
    if (next.done) { this.ended = true; return false; }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
    return true;
  }

  async read(length: number) {
    while (this.buffer.length < length && !this.ended) await this.pull();
    if (this.buffer.length < length) return null;
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  async *take(length: number): AsyncIterable<Buffer> {
    let left = length;
    while (left > 0) {
      if (!this.buffer.length && !(await this.pull())) throw new ArchiveError("The archive ends in the middle of a file (it's incomplete).");
      const size = Math.min(left, this.buffer.length);
      yield this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      left -= size;
    }
  }

  async skip(length: number) { for await (const chunk of this.take(length)) void chunk; }
}

function tarString(block: Buffer, start: number, length: number) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function tarNumber(block: Buffer, start: number, length: number) {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    // GNU base-256 for sizes over 8 GB.
    let value = 0;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index];
    return value;
  }
  const text = field.toString("latin1").replace(/[\0 ]+/g, "").trim();
  return text ? parseInt(text, 8) : 0;
}

function paxPath(records: Buffer) {
  let found: string | undefined;
  let position = 0;
  while (position < records.length) {
    const space = records.indexOf(0x20, position);
    if (space === -1) break;
    const length = Number(records.subarray(position, space).toString("latin1"));
    if (!length) break;
    const record = records.subarray(space + 1, position + length - 1).toString("utf8");
    if (record.startsWith("path=")) found = record.slice(5);
    position += length;
  }
  return found;
}

async function visitTar(source: AsyncIterable<Buffer>, limits: ArchiveLimits, visit: Visit) {
  const reader = new ChunkReader(source);
  let skipped = 0;
  let entries = 0;
  let longName: string | undefined;
  while (true) {
    const header = await reader.read(512);
    if (!header || header.every((byte) => byte === 0)) break;
    const size = tarNumber(header, 124, 12);
    const padded = Math.ceil(size / 512) * 512;
    const flag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(257, 262).toString("latin1") === "ustar" ? tarString(header, 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    longName = undefined;
    if (flag === "L" || flag === "x") {
      const data = Buffer.concat(await Array.fromAsync(reader.take(size)));
      await reader.skip(padded - size);
      longName = flag === "L" ? data.toString("utf8").replace(/\0+$/, "") : paxPath(data);
      continue;
    }
    if (flag !== "0" && flag !== "7" && flag !== "5") {
      // Symlinks, hard links, devices, global pax headers: skipped.
      if (flag !== "g") skipped += 1;
      await reader.skip(padded);
      continue;
    }
    entries += 1;
    if (entries > limits.maxEntries) throw new ArchiveError(`The archive has more than ${limits.maxEntries} entries.`);
    const type = flag === "5" ? "directory" : "file";
    const entryPath = safeEntryPath(name);
    let consumed = false;
    if (entryPath) await visit({ path: entryPath, type, size: type === "file" ? size : 0 }, () => { consumed = true; return reader.take(size); });
    if (!consumed) await reader.skip(size);
    await reader.skip(padded - size);
  }
  return skipped;
}

async function visitArchive(file: string, limits: ArchiveLimits, visit: Visit) {
  const kind = await kindOf(file);
  if (kind === "zip") return visitZip(file, limits, visit);
  const raw = createReadStream(file);
  try { return await visitTar(kind === "tar.gz" ? raw.pipe(createGunzip()) : raw, limits, visit); }
  catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("Z_")) throw new ArchiveError("The .tar.gz file is damaged or incomplete.");
    throw error;
  }
  finally { raw.destroy(); }
}

/** Every file and folder in the archive, without extracting anything. */
export async function listArchive(file: string, limits = DEFAULT_LIMITS) {
  const entries: ArchiveEntry[] = [];
  let total = 0;
  const skipped = await visitArchive(file, limits, async (entry) => {
    total += entry.size;
    if (total > limits.maxTotalBytes) throw new ArchiveError(`The archive unpacks to more than ${Math.round(limits.maxTotalBytes / 1024 ** 3)} GB.`);
    entries.push(entry);
  });
  return { entries, skipped, totalBytes: total };
}

/**
 * Extracts into `destination`, which must be an existing empty directory. With `prefix` (a folder
 * inside the archive), only that folder's contents are extracted, to the top of `destination`.
 */
export async function extractArchive(file: string, destination: string, options: { prefix?: string; limits?: ArchiveLimits; freeSpaceMargin?: number } = {}) {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const prefix = options.prefix ? `${safeEntryPath(options.prefix)}/` : "";
  const listing = await listArchive(file, limits);
  const needed = listing.entries.filter((entry) => entry.path.startsWith(prefix)).reduce((sum, entry) => sum + entry.size, 0);
  const space = await statfs(destination).catch(() => undefined);
  if (space && space.bavail * space.bsize < needed + (options.freeSpaceMargin ?? 1024 ** 3)) {
    throw new ArchiveError(`Not enough free disk space: this needs ${(needed / 1024 ** 3).toFixed(1)} GB plus 1 GB to spare.`);
  }
  if ((await stat(destination)).isDirectory() === false) throw new ArchiveError("The extraction folder is missing.");
  const seen = new Set<string>();
  const result = { files: 0, directories: 0, bytes: 0, skipped: listing.skipped };
  await visitArchive(file, limits, async (entry, content) => {
    if (prefix && !entry.path.startsWith(prefix)) return;
    const relative = entry.path.slice(prefix.length);
    if (!relative) return;
    if (seen.has(relative) && entry.type === "file") throw new ArchiveError(`The archive contains ${relative} more than once.`);
    seen.add(relative);
    const target = path.join(destination, ...relative.split("/"));
    if (entry.type === "directory") {
      await mkdir(target, { recursive: true, mode: 0o770 });
      result.directories += 1;
      return;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o770 });
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o660);
    try {
      for await (const chunk of content()) {
        result.bytes += chunk.length;
        if (result.bytes > limits.maxTotalBytes) throw new ArchiveError("The archive unpacks to more than it says.");
        await handle.write(chunk);
      }
    } finally { await handle.close(); }
    result.files += 1;
  });
  return result;
}

/**
 * Where a Java world is inside an archive: the folder holding the shallowest level.dat ("" for the
 * top). Throws a readable error for archives that aren't a Java world.
 */
export function findWorldFolder(entries: ArchiveEntry[]) {
  const levels = entries.filter((entry) => entry.type === "file" && /(^|\/)level\.dat$/i.test(entry.path)).map((entry) => entry.path);
  if (!levels.length) {
    if (entries.some((entry) => /(^|\/)levelname\.txt$/i.test(entry.path)) && entries.some((entry) => /(^|\/)db\//.test(entry.path))) {
      throw new ArchiveError("This is a Bedrock world. Java servers can't load it; it needs converting first (for example with Chunker).");
    }
    throw new ArchiveError("No level.dat was found, so this doesn't look like a Minecraft world.");
  }
  const shallowest = levels.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  return shallowest.includes("/") ? shallowest.slice(0, shallowest.lastIndexOf("/")) : "";
}
