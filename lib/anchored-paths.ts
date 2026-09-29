import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
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
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment))) {
    throw new BadRequestError("Invalid file path.");
  }
  return segments;
}

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

  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await open(root, flags);
  try {
    for (const segment of segments) {
      const next = await open(`/proc/self/fd/${handle.fd}/${segment}`, flags);
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
