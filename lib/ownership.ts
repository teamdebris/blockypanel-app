import { lchown, lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** The user and group the Minecraft image runs the game as. */
export const GAME_UID = 1000;

type Ops = {
  lstat: (file: string) => Promise<{ uid: number; gid: number; isFile(): boolean; isDirectory(): boolean }>;
  lchown: (file: string, uid: number, gid: number) => Promise<void>;
  readdir: (directory: string) => Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>;
};

const fs: Ops = { lstat, lchown, readdir: (directory) => readdir(directory, { withFileTypes: true }) };

/**
 * Hands every file and folder under `root` (and root itself) that isn't the game's to the game's user.
 * Links are never followed or changed. Only safe while nothing else can change the tree, since a
 * folder swapped for a link mid-walk would be followed: callers run it with the server stopped.
 * Returns how many entries changed owner.
 */
export async function giveTreeToGame(root: string, ops: Ops = fs) {
  let changed = 0;
  const fix = async (full: string) => {
    const info = await ops.lstat(full).catch(() => undefined);
    if (!info || !(info.isFile() || info.isDirectory()) || (info.uid === GAME_UID && info.gid === GAME_UID)) return;
    await ops.lchown(full, GAME_UID, GAME_UID).then(() => { changed += 1; }, () => undefined);
  };
  const walk = async (directory: string) => {
    for (const entry of await ops.readdir(directory).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      if (entry.isDirectory() || entry.isFile()) await fix(full);
    }
  };
  await walk(root);
  await fix(root);
  return changed;
}
