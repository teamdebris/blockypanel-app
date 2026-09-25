import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { ArchiveError, extractArchive, findWorldFolder, listArchive, safeEntryPath } from "../lib/archive.ts";

type ZipItem = { name: string; data?: string; deflate?: boolean; symlink?: boolean; badCrc?: boolean };

/** A minimal zip writer, enough to build test archives (including hostile ones). */
function zip(items: ZipItem[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data ?? "");
    const body = item.deflate ? deflateRawSync(data) : data;
    const crc = item.badCrc ? 1 : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(item.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE((3 << 8) | 20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(item.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28);
    const mode = item.symlink ? 0o120777 : item.name.endsWith("/") ? 0o040755 : 0o100644;
    entry.writeUInt32LE((mode << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A minimal ustar writer. */
function tar(items: { name: string; data?: string; type?: string }[]) {
  const blocks: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? "");
    const header = Buffer.alloc(512);
    header.write(item.name, 0, 100, "utf8");
    header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write(item.type ?? "0", 156);
    header.write("ustar\u000000", 257);
    header.fill(0x20, 148, 156);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function withTemp(work: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-archive-"));
  try { await work(folder); } finally { await rm(folder, { recursive: true, force: true }); }
}

const world = [
  { name: "My World/", data: "" },
  { name: "My World/level.dat", data: "LEVEL", deflate: true },
  { name: "My World/region/r.0.0.mca", data: "REGION".repeat(100), deflate: true },
  { name: "My World/DIM-1/region/r.0.0.mca", data: "NETHER" },
];

test("entry paths can't escape the destination", () => {
  assert.equal(safeEntryPath("./world/level.dat"), "world/level.dat");
  assert.equal(safeEntryPath("world\\region\\r.0.0.mca"), "world/region/r.0.0.mca");
  for (const bad of ["../evil", "world/../../evil", "/etc/passwd", "C:/Windows/evil", "a\0b"]) assert.throws(() => safeEntryPath(bad), ArchiveError, bad);
});

test("zip worlds are listed and extracted from inside their folder", () => withTemp(async (folder) => {
  const file = path.join(folder, "world.zip");
  await writeFile(file, zip(world));
  const { entries } = await listArchive(file);
  assert.equal(findWorldFolder(entries), "My World");
  const out = path.join(folder, "out");
  await mkdir(out);
  const result = await extractArchive(file, out, { prefix: "My World", freeSpaceMargin: 0 });
  assert.equal(result.files, 3);
  assert.equal(await readFile(path.join(out, "level.dat"), "utf8"), "LEVEL");
  assert.equal(await readFile(path.join(out, "region", "r.0.0.mca"), "utf8"), "REGION".repeat(100));
  assert.equal(await readFile(path.join(out, "DIM-1", "region", "r.0.0.mca"), "utf8"), "NETHER");
}));

test("hostile zips are refused, links skipped, and damage detected", () => withTemp(async (folder) => {
  const cases: [string, ZipItem[], RegExp][] = [
    ["traversal.zip", [{ name: "../../evil.txt", data: "x" }], /outside/],
    ["absolute.zip", [{ name: "/tmp/evil.txt", data: "x" }], /absolute/],
    ["crc.zip", [{ name: "level.dat", data: "LEVEL", badCrc: true }], /checksum/],
  ];
  for (const [name, items, message] of cases) {
    const file = path.join(folder, name);
    await writeFile(file, zip(items));
    const out = path.join(folder, `out-${name}`);
    await mkdir(out);
    await assert.rejects(extractArchive(file, out, { freeSpaceMargin: 0 }), message, name);
  }
  const linked = path.join(folder, "link.zip");
  await writeFile(linked, zip([{ name: "level.dat", data: "LEVEL" }, { name: "escape", data: "/etc", symlink: true }]));
  const out = path.join(folder, "out-link");
  await mkdir(out);
  const result = await extractArchive(linked, out, { freeSpaceMargin: 0 });
  assert.equal(result.skipped, 1);
  assert.deepEqual(await readdir(out), ["level.dat"]);
  await writeFile(path.join(folder, "junk.zip"), "not an archive at all");
  await assert.rejects(listArchive(path.join(folder, "junk.zip")), /isn't a \.zip/);
}));

test("tar and tar.gz archives extract too, with links skipped", () => withTemp(async (folder) => {
  const items = [{ name: "world/", type: "5" }, { name: "world/level.dat", data: "LEVEL" }, { name: "world/link", type: "2" }, { name: "world/region/r.0.0.mca", data: "R".repeat(1500) }];
  for (const [name, data] of [["world.tar", tar(items)], ["world.tar.gz", gzipSync(tar(items))]] as const) {
    const file = path.join(folder, name);
    await writeFile(file, data);
    const { entries } = await listArchive(file);
    assert.equal(findWorldFolder(entries), "world");
    const out = path.join(folder, `out-${name}`);
    await mkdir(out);
    const result = await extractArchive(file, out, { prefix: "world", freeSpaceMargin: 0 });
    assert.equal(result.skipped, 1, name);
    assert.equal(await readFile(path.join(out, "region", "r.0.0.mca"), "utf8"), "R".repeat(1500));
  }
  const evil = path.join(folder, "evil.tar");
  await writeFile(evil, tar([{ name: "../evil", data: "x" }]));
  await assert.rejects(listArchive(evil), /outside/);
}));

test("archives that aren't Java worlds get a clear message", () => {
  assert.throws(() => findWorldFolder([{ path: "readme.txt", type: "file", size: 1 }]), /No level\.dat/);
  assert.throws(() => findWorldFolder([{ path: "w/levelname.txt", type: "file", size: 1 }, { path: "w/db/CURRENT", type: "file", size: 1 }]), /Bedrock/);
  assert.equal(findWorldFolder([{ path: "level.dat", type: "file", size: 1 }, { path: "backup/level.dat", type: "file", size: 1 }]), "");
});
