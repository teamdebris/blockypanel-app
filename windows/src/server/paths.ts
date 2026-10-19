import path from "node:path";
import os from "node:os";

/** Everything lives here: the Java runtime, each server's folder, and backups. BLOCKY_DATA overrides it (tests). */
export const DATA_ROOT = process.env.BLOCKY_DATA || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Blocky Panel");
export const RUNTIME_DIR = path.join(DATA_ROOT, "runtime");
export const SERVERS_DIR = path.join(DATA_ROOT, "servers");
export const BACKUPS_DIR = path.join(DATA_ROOT, "backups");
export const STATE_FILE = path.join(DATA_ROOT, "servers.json");

const ID = /^[a-z0-9]{12}$/;
export const isServerId = (id: string) => ID.test(id);
export const serverDir = (id: string) => { if (!isServerId(id)) throw new Error("Invalid server."); return path.join(SERVERS_DIR, id); };
export const backupDir = (id: string) => { if (!isServerId(id)) throw new Error("Invalid server."); return path.join(BACKUPS_DIR, id); };
