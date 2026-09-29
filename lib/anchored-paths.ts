import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { BadRequestError } from "./errors.ts";

/** A directory kept open while filesystem operations use paths relative to that exact inode. */
export type AnchoredDirectory = { path: string; close: () => Promise<void> };

export function insideRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function segmentsOf(relative: string) {
  if (!relative) return [];
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\/\0]/.test(segment))) {
    throw new BadRequestError("Invalid file path.");
  }
  return segments;
}

const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

/**
 * On Linux, each component is opened with O_NOFOLLOW and the next is resolved through its held
 * descriptor. A game plugin can rename a directory or replace its old name with a symlink without
 * changing where subsequent operations land. The Windows development fallback keeps the existing
 * containment check; the production Docker image runs on Linux with /proc mounted.
 */
export async function anchorDirectory(root: string, relative = ""): Promise<AnchoredDirectory> {
  const segments = segmentsOf(relative);
  if (process.platform !== "linux") {
    const target = path.resolve(root, ...segments);
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!insideRoot(realRoot, realTarget)) throw new BadRequestError("Invalid file path.");
    return { path: target, close: async () => undefined };
  }

  let handle = await open(root, DIRECTORY_FLAGS);
  try {
    for (const segment of segments) {
      const next = await open(`/proc/self/fd/${handle.fd}/${segment}`, DIRECTORY_FLAGS);
      await handle.close();
      handle = next;
    }
    let closed = false;
    return {
      path: `/proc/self/fd/${handle.fd}`,
      close: async () => { if (!closed) { closed = true; await handle.close(); } },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function anchorParent(root: string, relative: string) {
  const segments = segmentsOf(relative);
  const name = segments.pop();
  if (!name) throw new BadRequestError("Invalid file path.");
  return { ...await anchorDirectory(root, segments.join("/")), name };
}

/**
 * Deletes `name` inside an anchored directory, recursively. On Linux every subdirectory is opened
 * with O_NOFOLLOW and emptied through its own descriptor, so nothing is ever resolved by path
 * twice: a game that swaps a directory for a symlink partway through can't redirect the deletion
 * at what the link points to. Links are removed, never followed. Elsewhere Node's rm walks by path.
 */
export async function removeAnchored(directoryPath: string, name: string) {
  if (process.platform !== "linux") {
    await rm(path.join(directoryPath, name), { recursive: true, force: false });
    return;
  }
  await removeEntry(directoryPath, name);
}

async function removeEntry(directoryPath: string, name: string) {
  const target = `${directoryPath}/${name}`;
  if (!(await lstat(target)).isDirectory()) { await unlink(target); return; }
  let handle;
  try { handle = await open(target, DIRECTORY_FLAGS); }
  catch (error) {
    // Swapped for a link since the lstat: unlink removes the link itself.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") { await unlink(target); return; }
    throw error;
  }
  try {
    const inside = `/proc/self/fd/${handle.fd}`;
    for (const entry of await readdir(inside)) await removeEntry(inside, entry);
  } finally { await handle.close(); }
  // rmdir refuses a symlink (ENOTDIR), so a swap after the directory was emptied fails rather than follows.
  await rmdir(target);
}
