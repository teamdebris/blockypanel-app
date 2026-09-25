import "server-only";

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { extractArchive, findWorldFolder, listArchive } from "@/lib/archive";
import { assertManagedServer, changeServerFiles } from "@/lib/docker";
import { BadRequestError } from "@/lib/errors";
import { archiveProblem, chownTree, serverArchivePath } from "@/lib/files";
import { setOperationStep, startServerOperation } from "@/lib/operations";
import { serverDataPath } from "@/lib/paths";
import { recordEvent } from "@/lib/store";
import { levelName, worldFolders } from "@/lib/world";

/** Reads level-name without following a symlinked server.properties. */
async function currentLevelName(id: string) {
  const file = path.join(serverDataPath(id), "server.properties");
  const info = await lstat(file).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new BadRequestError("server.properties is a symbolic link; fix it before importing a world.");
  return levelName(info ? await readFile(file, "utf8") : "");
}

/**
 * Replaces a server's world with one from an uploaded .zip, .tar, or .tar.gz. The archive is
 * checked and unpacked while the server runs; then a safety backup is taken, the server stopped,
 * the world folders swapped, and the server started. On failure the safety backup is restored.
 */
export async function importWorld(id: string, requested: string) {
  await assertManagedServer(id);
  if (process.env.BLOCKY_DEMO === "true") {
    return startServerOperation(id, "world-import", "Importing a world", async () => {
      for (const step of ["Unpacking the world", "Taking a safety backup", "Replacing the world", "Waiting for Minecraft to start"]) { setOperationStep(id, step); await new Promise((resolve) => setTimeout(resolve, 1500)); }
      await recordEvent(id, "world-import", "World imported (demo).", "success");
    });
  }
  const { target, relative } = await serverArchivePath(id, requested);
  // Checked before anything is stopped, so a bad archive or level-name fails without downtime.
  const level = await currentLevelName(id);
  const { entries } = await listArchive(target).catch(archiveProblem);
  const folder = (() => { try { return findWorldFolder(entries); } catch (error) { return archiveProblem(error); } })();
  const root = serverDataPath(id);
  const staging = path.join(root, `.blocky-import-${randomUUID()}`);
  return changeServerFiles(id, {
    kind: "world-import",
    label: "Importing a world",
    step: "Replacing the world",
    success: `World imported from ${relative}.`,
    // A converted world can take a while on its first start.
    startupTimeoutMs: 15 * 60_000,
    prepare: async () => {
      setOperationStep(id, "Unpacking the world");
      await mkdir(staging, { mode: 0o770 });
      await extractArchive(target, staging, { prefix: folder || undefined }).catch(archiveProblem);
      await chownTree(staging);
    },
    change: async () => {
      for (const name of worldFolders(level)) {
        // rm removes a symlink itself, never what it points to.
        if (await lstat(path.join(root, name)).catch(() => undefined)) await rm(path.join(root, name), { recursive: true, force: true });
      }
      await rename(staging, path.join(root, level));
      // A lock left by the game that saved the world would stop the server from opening it.
      await rm(path.join(root, level, "session.lock"), { force: true });
    },
    cleanup: () => rm(staging, { recursive: true, force: true }),
  });
}
