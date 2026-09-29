import "server-only";

import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { extractArchive, findWorldFolder, listArchive } from "@/lib/archive";
import { assertManagedServer, changeServerFiles } from "@/lib/docker";
import { NotFoundError } from "@/lib/errors";
import { archiveProblem, chownTree, readServerTextFile, serverArchivePath } from "@/lib/files";
import { setOperationStep, startServerOperation } from "@/lib/operations";
import { serverDataPath, serverRootPath, storagePath } from "@/lib/paths";
import { recordEvent } from "@/lib/store";
import { levelName, worldFolders } from "@/lib/world";

/** Reads level-name through the same anchored path used by the file manager. */
async function currentLevelName(id: string) {
  try { return levelName(await readServerTextFile(id, "server.properties")); }
  catch (error) { if (error instanceof NotFoundError) return "world"; throw error; }
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
  const archive = await serverArchivePath(id, requested);
  const { target, relative } = archive;
  try {
    // Checked before anything is stopped, so a bad archive or level-name fails without downtime.
    const level = await currentLevelName(id);
    const { entries } = await listArchive(target).catch(archiveProblem);
    const folder = (() => { try { return findWorldFolder(entries); } catch (error) { return archiveProblem(error); } })();
    const root = serverDataPath(id);
    const staging = storagePath(serverRootPath(id), `.blocky-import-${randomUUID()}`);
    return await changeServerFiles(id, {
      kind: "world-import",
      label: "Importing a world",
      step: "Replacing the world",
      success: `World imported from ${relative}.`,
      // A converted world can take a while on its first start.
      startupTimeoutMs: 15 * 60_000,
      prepare: async () => {
        setOperationStep(id, "Unpacking the world");
        await mkdir(staging, { mode: 0o700 });
        await extractArchive(target, staging, { prefix: folder || undefined }).catch(archiveProblem);
        await chownTree(staging);
      },
      change: async () => {
        for (const name of worldFolders(level)) {
          // rm removes a symlink itself, never what it points to.
          if (await lstat(storagePath(root, name)).catch(() => undefined)) await rm(storagePath(root, name), { recursive: true, force: true });
        }
        await rename(staging, storagePath(root, level));
        // A lock left by the game that saved the world would stop the server from opening it.
        await rm(storagePath(root, level, "session.lock"), { force: true });
      },
      cleanup: async () => { try { await rm(staging, { recursive: true, force: true }); } finally { await archive.close(); } },
    });
  } catch (error) { await archive.close(); throw error; }
}
