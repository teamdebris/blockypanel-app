import "server-only";

import path from "node:path";
import { BadRequestError } from "@/lib/errors";

/**
 * Joins storage paths through a function the build's file tracer can't follow. The tracer reads
 * path.join calls statically and copies whatever files they could point to into the build output;
 * turbopackIgnore only drops the storage root, so "servers/..." and "backups/..." were resolved from
 * the project folder. With an install living there (/opt/blocky-panel), worlds and restic passwords
 * ended up in .next/standalone. Every storage-derived path goes through storagePath().
 */
export const storagePath: (...parts: string[]) => string = Reflect.get(path, "join");

export const STORAGE_ROOT = path.resolve(/* turbopackIgnore: true */ process.env.BLOCKY_STORAGE || "storage");
const DOCKER_STORAGE_ROOT = path.resolve(/* turbopackIgnore: true */ process.env.BLOCKY_DOCKER_STORAGE || STORAGE_ROOT);

const SERVER_ID = /^[a-zA-Z0-9-]{1,64}$/;

export function isServerId(id: string) {
  return SERVER_ID.test(id);
}

export function assertServerId(id: string) {
  if (!isServerId(id)) throw new BadRequestError("Invalid server ID.");
  return id;
}

export function serverRootPath(id: string) {
  return storagePath(STORAGE_ROOT, "servers", assertServerId(id));
}

export function serverDataPath(id: string) {
  return storagePath(serverRootPath(id), "data");
}

export function serverMetaPath(id: string) {
  return storagePath(serverRootPath(id), "server.json");
}

export function dockerServerDataPath(id: string) {
  return storagePath(DOCKER_STORAGE_ROOT, "servers", assertServerId(id), "data");
}

export function serverBackupPath(id: string) {
  return storagePath(STORAGE_ROOT, "backups", assertServerId(id));
}

/** The panel's own files (database, control state, caches), kept apart from servers and backups. */
export const PANEL_ROOT = storagePath(STORAGE_ROOT, "panel");

export function resticCachePath() {
  return storagePath(PANEL_ROOT, "cache", "restic");
}
