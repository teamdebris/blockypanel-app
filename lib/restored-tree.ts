import { chmod, lchown, lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Makes a tree restic just restored from a destination the panel doesn't control safe to hand to
 * the game: every entry goes to the game's user, and set-user-ID and set-group-ID bits come off
 * regular files. restic restores ownership and modes as root, so a tampered offsite copy could
 * otherwise leave a root-owned setuid program on the host's disk. Runs with the server stopped,
 * so names are stable; links are left alone and never followed. No Next.js imports, so it's tested
 * directly.
 */
export async function sanitizeRestoredTree(directory: string, owner = { uid: 1000, gid: 1000 }) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const info = await lstat(full).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
    if (info.isDirectory()) await sanitizeRestoredTree(full, owner);
    else if (info.isFile() && info.mode & 0o6000) await chmod(full, info.mode & 0o777);
    await lchown(full, owner.uid, owner.gid).catch(() => undefined);
  }
}
