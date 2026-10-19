import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { extractArchive, findWorldFolder, listArchive } from "../../../lib/archive";
import { isSafeSeed, levelName, worldFolders } from "../../../lib/world";
import { createBackup } from "./backups";
import { recordEvent } from "./control";
import { HttpError } from "./errors";
import { assertFilesStopped, cleanPath, makeDirectory, readText, safeTarget, uploadFile } from "./files";
import { DATA_ROOT } from "./paths";
import { updateServer, type ServerConfig } from "./store";

const LIMITS = { maxEntries: 200000, maxTotalBytes: 64 * 1024 ** 3 };
export const MAX_WORLD_UPLOAD = 4 * 1024 ** 3;
const ARCHIVE = /\.(zip|tar|tar\.gz|tgz)$/i;

export async function worldInfo(server: ServerConfig) {
  assertFilesStopped(server.id);
  let properties = "";
  try { properties = (await readText(server.id, "server.properties")).content; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const folder = levelName(properties);
  cleanPath(folder);
  const folders: string[] = [];
  for (const name of worldFolders(folder)) {
    try {
      const { target } = await safeTarget(server.id, name);
      if (!(await lstat(target)).isDirectory()) throw new HttpError(400, `${name} is not an ordinary world directory.`);
      folders.push(name);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { folder, folders };
}

async function stageFor(id: string) {
  const root = path.join(DATA_ROOT, "staging");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new HttpError(400, "The staging folder cannot be a link or junction.");
  const stage = path.join(root, `world-${id}-${randomUUID()}`);
  const relative = path.relative(root, stage);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid staging path.");
  await mkdir(stage);
  return stage;
}

async function replaceWorld(server: ServerConfig, stage: string, imported?: string, seed?: string) {
  const moved: { from: string; to: string }[] = [];
  let importedTarget: string | undefined;
  let preserve = false;
  try {
    const info = await worldInfo(server);
    await createBackup(server.id, "safety");
    await mkdir(path.join(stage, "previous"));
    for (const name of info.folders) {
      const { target } = await safeTarget(server.id, name);
      const held = path.join(stage, "previous", name);
      await rename(target, held); moved.push({ from: held, to: target });
    }
    if (imported) {
      const { target } = await safeTarget(server.id, info.folder, true);
      await rename(imported, target); importedTarget = target;
    }
    if (seed !== undefined) await updateServer(server.id, { seed });
  } catch (error) {
    try {
      if (importedTarget) await rename(importedTarget, path.join(stage, "failed-import"));
      for (const old of moved.reverse()) await rename(old.from, old.to);
    } catch {
      preserve = true;
      throw new HttpError(500, `World replacement failed and rollback could not finish. Original worlds are preserved in ${stage}; a safety backup is also available.`);
    }
    throw error;
  } finally {
    if (!preserve) await rm(stage, { recursive: true, force: true });
  }
}

export async function resetWorld(server: ServerConfig, seed: unknown) {
  assertFilesStopped(server.id);
  if (typeof seed !== "string" || seed.length > 64 || !isSafeSeed(seed)) throw new HttpError(400, "Use a seed of at most 64 characters without control characters.");
  const stage = await stageFor(server.id);
  await replaceWorld(server, stage, undefined, seed.trim());
  await recordEvent(server.id, "World reset; previous worlds were saved in a safety backup.", "success");
}

export async function importWorld(server: ServerConfig, filename: string, request: IncomingMessage) {
  assertFilesStopped(server.id);
  const name = cleanPath(filename);
  if (name.includes("/") || !ARCHIVE.test(name)) throw new HttpError(400, "Choose a Java world in a ZIP, TAR, or TAR.GZ archive.");
  try { await makeDirectory(server.id, ".blocky-uploads"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const uploaded = `.blocky-uploads/${randomUUID()}-${name}`;
  const stage = await stageFor(server.id);
  let retained = false;
  try {
    await uploadFile(server.id, uploaded, request, MAX_WORLD_UPLOAD);
    const { target: archive } = await safeTarget(server.id, uploaded);
    const listing = await listArchive(archive, LIMITS);
    const names = new Map<string, string>();
    for (const entry of listing.entries) {
      cleanPath(entry.path);
      const normalized = entry.path.toLowerCase();
      const previous = names.get(normalized);
      if (previous && previous !== entry.path) throw new HttpError(400, `The archive has filenames that differ only by case (${entry.path}). Rename them before importing on Windows.`);
      names.set(normalized, entry.path);
    }
    const prefix = findWorldFolder(listing.entries);
    const world = path.join(stage, "imported"); await mkdir(world);
    await extractArchive(archive, world, { prefix, limits: LIMITS });
    // Normalize Bukkit sibling dimensions into the Java world's DIM folders. Paper migrates these
    // back to sibling directories on its first start; Vanilla/Fabric use them directly.
    if (prefix) {
      for (const [suffix, dimension] of [["_nether", "DIM-1"], ["_the_end", "DIM1"]]) {
        const sibling = `${prefix}${suffix}`;
        if (!listing.entries.some((entry) => entry.path.startsWith(`${sibling}/${dimension}/`))) continue;
        try { await lstat(path.join(world, dimension)); throw new HttpError(400, `The archive contains two copies of ${dimension}; choose one world layout before importing.`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const extra = path.join(stage, dimension); await mkdir(extra);
        await extractArchive(archive, extra, { prefix: `${sibling}/${dimension}`, limits: LIMITS });
        await rename(extra, path.join(world, dimension));
      }
    }
    if (!(await lstat(path.join(world, "level.dat"))).isFile()) throw new HttpError(400, "A Java world's level.dat must be at the top of its world folder.");
    retained = true; // replaceWorld owns cleanup, retaining staging only when rollback itself fails.
    await replaceWorld(server, stage, world);
    await recordEvent(server.id, "Java world imported; previous worlds were saved in a safety backup.", "success");
  } finally {
    if (!retained) await rm(stage, { recursive: true, force: true });
    const { target } = await safeTarget(server.id, uploaded, true);
    await rm(target, { force: true });
  }
}
