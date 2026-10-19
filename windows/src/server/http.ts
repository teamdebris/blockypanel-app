import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createBackup, deleteBackup, listBackups, restoreBackup } from "./backups";
import { consoleLines, events, isActive, querySeed, restart, runtimeInfo, sendCommand, start, stop, type Line } from "./minecraft";
import { chunkbaseUrl } from "../../../lib/chunkbase";
import { backupDir, DATA_ROOT, serverDir } from "./paths";
import { versions } from "./software";
import { addServer, type Difficulty, GAME_DEFAULTS, getServer, ICONS, loadServers, removeServer, SOFTWARE, type Software, updateServer } from "./store";
import { errorStatus, HttpError } from "./errors";
import { activeOperation, withServerLock } from "./operations";
import { changeControl, getControl, recordEvent, removeControl } from "./control";
import { deleteTask, listTasks, saveTask } from "./tasks";
import { cleanPath, deleteFile, listFiles, makeDirectory, MAX_TEXT_BYTES, readText, renameFile, uploadFile, writeText, openDownload } from "./files";
import { installAddon, listAddons, planAddon, removeAddon, searchAddons } from "./modrinth";
import { importWorld, resetWorld, worldInfo } from "./world";
import { maintainRepository } from "./restic";
import { configureOffsite, copyOffsite, copyOffsiteAfterBackup, discoverOffsite, disconnectOffsite, offsiteSnapshots, offsiteStatus, restoreOffsite } from "./offsite";

import release from "../../../package.json";

export const VERSION = release.version;
const UI_BUILD = `${VERSION}-${process.pid}-${Date.now()}`;

/** The UI: embedded in the executable (node:sea assets), or read from dist/web when run with node. */
async function asset(name: string): Promise<Buffer | undefined> {
  try {
    const sea = await import("node:sea");
    if (sea.isSea()) return Buffer.from(sea.getAsset(name));
  } catch { /* not a single executable */ }
  return readFile(path.join(__dirname, "web", name)).catch(() => undefined);
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const STATIC = /^\/(app\.js|app\.css|theme\.js|favicon\.svg|brand\/[a-z-]+\.svg|blocks\/[a-z-]+\.svg)$/;

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body<T>(req: http.IncomingMessage, max = 64 * 1024): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, "That request is too large."); chunks.push(chunk); }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as T;
  } catch { throw new HttpError(400, "Send a JSON object."); }
}

/**
 * The address players on your network join with: this PC's LAN IPv4. Virtual adapters (Hyper-V,
 * WSL, VirtualBox, VMware, VPNs) are skipped, so it's the one friends' devices can reach.
 */
function lanAddress() {
  const virtual = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier|Npcap|Bluetooth/i;
  const candidates = Object.entries(os.networkInterfaces())
    .filter(([name]) => !virtual.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254."));
  const preferred = candidates.find((item) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));
  return (preferred ?? candidates[0])?.address ?? "127.0.0.1";
}

async function summary(id: string) {
  const config = await getServer(id);
  if (!config) throw new HttpError(404, "That server doesn't exist.");
  return { ...config, ...runtimeInfo(id), operation: activeOperation(id), address: `${lanAddress()}:${config.port}` };
}

const MEMORY = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384];
const DIFFICULTIES: Difficulty[] = ["peaceful", "easy", "normal", "hard"];

function userPath(value: unknown) {
  if (typeof value !== "string") throw new HttpError(400, "Choose a file path.");
  const relative = cleanPath(value);
  if (relative.split("/").some((part) => part.toLowerCase().startsWith(".blocky-"))) throw new HttpError(400, "This file is managed by Blocky.");
  return relative;
}

function validSettings(input: Record<string, unknown>, creating: boolean) {
  const out: Record<string, unknown> = {};
  if (input.name !== undefined || creating) {
    const name = String(input.name ?? "").trim();
    if (name.length < 2 || name.length > 40) throw new HttpError(400, "Give the server a name of 2 to 40 characters.");
    out.name = name;
  }
  if (input.memoryMb !== undefined || creating) {
    if (!MEMORY.includes(Number(input.memoryMb))) throw new HttpError(400, "Pick a memory size from the list.");
    out.memoryMb = Number(input.memoryMb);
  }
  if (input.port !== undefined || creating) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, "The port must be between 1024 and 65535.");
    out.port = port;
  }
  if (input.motd !== undefined) out.motd = String(input.motd).replace(/[\r\n]/g, " ").slice(0, 120);
  if (input.maxPlayers !== undefined) {
    const max = Number(input.maxPlayers);
    if (!Number.isInteger(max) || max < 1 || max > 500) throw new HttpError(400, "Players must be between 1 and 500.");
    out.maxPlayers = max;
  }
  if (input.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(input.difficulty as Difficulty)) throw new HttpError(400, "Pick a difficulty from the list.");
    out.difficulty = input.difficulty;
  }
  if (input.icon !== undefined) {
    if (!ICONS.includes(String(input.icon))) throw new HttpError(400, "Pick an icon from the list.");
    out.icon = input.icon;
  }
  if (input.gameMode !== undefined) {
    if (!["survival", "creative", "adventure", "spectator"].includes(String(input.gameMode))) throw new HttpError(400, "Choose a valid game mode.");
    out.gameMode = input.gameMode;
  }
  for (const key of ["pvp", "hardcore", "allowFlight", "commandBlocks", "onlineMode"]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new HttpError(400, `Invalid ${key} setting.`);
      out[key] = input[key];
    }
  }
  for (const [key, min, max] of [["spawnProtection", 0, 1000], ["viewDistance", 2, 32], ["simulationDistance", 2, 32]] as const) {
    if (input[key] !== undefined) {
      if (!Number.isInteger(input[key]) || Number(input[key]) < min || Number(input[key]) > max) throw new HttpError(400, `${key} must be between ${min} and ${max}.`);
      out[key] = input[key];
    }
  }
  if (input.seed !== undefined) {
    if (typeof input.seed !== "string" || input.seed.length > 64 || /[\r\n\0]/.test(input.seed)) throw new HttpError(400, "Use a seed of at most 64 characters on one line.");
    out.seed = input.seed.trim();
  }
  return out;
}

async function portInUse(port: number, except?: string) {
  return (await loadServers()).some((server) => server.port === port && server.id !== except);
}

/** Server-sent events: the console so far, then each new line as it arrives. */
function consoleStream(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
  for (const line of consoleLines(id)) res.write(`data: ${JSON.stringify(line)}\n\n`);
  const onLine = (lineId: string, line: Line) => { if (lineId === id) res.write(`data: ${JSON.stringify(line)}\n\n`); };
  const onChange = (changeId: string) => { if (changeId === id) res.write(`event: status\ndata: ${JSON.stringify(runtimeInfo(id))}\n\n`); };
  events.on("line", onLine);
  events.on("change", onChange);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  req.on("close", () => { clearInterval(heartbeat); events.off("line", onLine); events.off("change", onChange); });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "offsite") {
    if (!parts[2] && method === "GET") return json(res, 200, await offsiteStatus());
    if (!parts[2] && method === "PUT") return json(res, 200, await configureOffsite(await body(req)));
    if (!parts[2] && method === "DELETE") { await disconnectOffsite(); return json(res, 200, { ok: true }); }
    if (parts[2] === "discover" && method === "POST") return json(res, 200, await discoverOffsite(await body(req)));
    if (parts[2] === "snapshots" && method === "POST") return json(res, 200, await offsiteSnapshots(await body(req)));
  }
  if (url.pathname === "/api/state" && method === "GET") {
    const servers = await Promise.all((await loadServers()).map((server) => summary(server.id)));
    return json(res, 200, { version: VERSION, dataRoot: DATA_ROOT, servers });
  }
  if (url.pathname === "/api/versions" && method === "GET") {
    const software = url.searchParams.get("software") || "paper";
    if (!SOFTWARE.includes(software as Software)) throw new HttpError(400, "Choose a supported server type.");
    return json(res, 200, { versions: await versions(software as Software) });
  }
  if (url.pathname === "/api/servers" && method === "POST") {
    const input = await body<Record<string, unknown>>(req);
    if (input.eula !== true) throw new HttpError(400, "Accept the Minecraft EULA to create a server.");
    if (!SOFTWARE.includes(input.software as Software)) throw new HttpError(400, "Choose a supported server type.");
    const software = input.software as Software;
    const version = String(input.version ?? "");
    if (!/^\d+(\.\d+)+$/.test(version)) throw new HttpError(400, "Pick a Minecraft version.");
    const settings = validSettings(input, true);
    if (await portInUse(settings.port as number)) throw new HttpError(409, `Another server already uses port ${settings.port}.`);
    const icons = ["grass", "stone", "sand", "snow", "oak-log", "dirt", "water", "copper-ore"];
    const server = await addServer({ ...GAME_DEFAULTS, software, version, motd: `${settings.name} · a Blocky server`, maxPlayers: 10, difficulty: "normal", icon: icons[(await loadServers()).length % icons.length], ...settings } as Parameters<typeof addServer>[0]);
    await recordEvent(server.id, "Server created.", "success");
    return json(res, 201, await summary(server.id));
  }
  if (parts[0] === "api" && parts[1] === "servers" && parts[2]) {
    const id = parts[2];
    const config = await getServer(id);
    if (!config) throw new HttpError(404, "That server doesn't exist.");
    const action = parts[3];
    if (!action && method === "GET") return json(res, 200, await summary(id));
    if (!action && method === "PATCH") {
      const settings = validSettings(await body(req), false);
      if (settings.port !== undefined && await portInUse(settings.port as number, id)) throw new HttpError(409, `Another server already uses port ${settings.port}.`);
      await withServerLock(id, "saving settings", () => updateServer(id, settings));
      await recordEvent(id, "Server settings updated.");
      return json(res, 200, { ...(await summary(id)), restartNeeded: isActive(id) && Object.keys(settings).some((key) => key !== "name" && key !== "icon") });
    }
    if (!action && method === "DELETE") {
      await withServerLock(id, "deleting server", async () => {
        if (isActive(id)) throw new HttpError(409, "Stop the server before deleting it.");
        await rm(serverDir(id), { recursive: true, force: true });
        await rm(backupDir(id), { recursive: true, force: true });
        await removeServer(id);
        await removeControl(id);
      });
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && (action === "start" || action === "stop" || action === "restart")) {
      // Starting can take minutes the first time (downloads); the UI follows along on the console.
      if (activeOperation(id)) throw new HttpError(409, `Wait for ${activeOperation(id)} to finish first.`);
      if (action === "start" && isActive(id)) throw new HttpError(409, "The server is already active.");
      const work = withServerLock(id, action, async () => {
        await recordEvent(id, `Server ${action} requested.`);
        await (action === "start" ? start(config) : action === "stop" ? stop(id) : restart(config));
      });
      work.catch((error) => { void recordEvent(id, `${action} failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error").catch(console.error); });
      return json(res, 202, { ok: true });
    }
    if (action === "command" && method === "POST") {
      const { command } = await body<{ command?: string }>(req);
      if (typeof command !== "string" || !command.trim() || command.length > 512 || /[\r\n\0]/.test(command)) throw new HttpError(400, "Type a command on one line.");
      sendCommand(id, command);
      await recordEvent(id, "Console command sent.");
      return json(res, 200, { ok: true });
    }
    if (action === "console" && method === "GET") return consoleStream(req, res, id);
    if (action === "events" && method === "GET") return json(res, 200, { events: (await getControl(id)).events });
    if (action === "offsite-copy" && method === "POST") return json(res, 200, await withServerLock(id, "copying backups off-site", () => copyOffsite(id, true)));
    if (action === "offsite-restore" && method === "POST") {
      const input = await body<{ destination: unknown; passphrase: string; serverId: string; snapshotId: string; confirmName: string }>(req);
      if (input.confirmName !== config.name) throw new HttpError(400, "Type the local server name to confirm the restore.");
      return json(res, 200, await withServerLock(id, "restoring off-site backup", () => restoreOffsite(config, input)));
    }
    if (action === "world") {
      if (!parts[4] && method === "GET") return json(res, 200, await withServerLock(id, "reading world details", () => worldInfo(config)));
      if (parts[4] === "reset" && method === "POST") {
        const input = await body<{ seed: string; confirmName: string }>(req);
        if (input.confirmName !== config.name) throw new HttpError(400, "Type the server name to confirm the world reset.");
        await withServerLock(id, "resetting world", () => resetWorld(config, input.seed));
        return json(res, 200, { ok: true });
      }
      if (parts[4] === "import" && method === "POST") {
        await withServerLock(id, "importing world", () => importWorld(config, url.searchParams.get("filename") || "", req));
        return json(res, 200, { ok: true });
      }
    }
    if (action === "seed" && method === "POST") {
      if (runtimeInfo(id).status !== "running") throw new HttpError(409, "Start the server before reading its seed.");
      const seed = await querySeed(id);
      return json(res, 200, { seed, mapUrl: chunkbaseUrl(seed, config.version) });
    }
    if (action === "modrinth") {
      const operation = parts[4];
      if (!operation && method === "GET") return json(res, 200, await listAddons(config));
      if (operation === "search" && method === "GET") return json(res, 200, await searchAddons(config, url.searchParams.get("q") || "", Number(url.searchParams.get("offset") || "0")));
      if ((operation === "plan" || operation === "install") && method === "POST") {
        const input = await body<{ projectId: string; optionalDependencies?: boolean; expectedPlan?: string }>(req);
        if (typeof input.projectId !== "string" || input.optionalDependencies !== undefined && typeof input.optionalDependencies !== "boolean") throw new HttpError(400, "Choose a valid project and dependency setting.");
        if (operation === "install" && (typeof input.expectedPlan !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedPlan))) throw new HttpError(400, "Preview the dependency plan before installing.");
        const result = await withServerLock<unknown>(id, operation === "plan" ? "checking dependencies" : "installing plugins or mods", () => operation === "plan" ? planAddon(config, input.projectId, input.optionalDependencies) : installAddon(config, input.projectId, input.optionalDependencies, input.expectedPlan));
        return json(res, 200, result);
      }
      if (operation && method === "DELETE") { const result = await withServerLock(id, "removing plugin or mod", () => removeAddon(config, operation)); return json(res, 200, result); }
    }
    if (action === "tasks") {
      const taskId = parts[4];
      if (!taskId && method === "GET") return json(res, 200, { tasks: await listTasks(id) });
      if (!taskId && method === "POST") return json(res, 201, await withServerLock(id, "saving task", async () => saveTask(id, await body(req))));
      if (taskId && method === "PUT") return json(res, 200, await withServerLock(id, "saving task", async () => saveTask(id, await body(req), taskId)));
      if (taskId && method === "DELETE") { await withServerLock(id, "deleting task", () => deleteTask(id, taskId)); return json(res, 200, { ok: true }); }
    }
    if (action === "backup-policy") {
      if (method === "GET") { const state = await getControl(id); return json(res, 200, { policy: state.backupPolicy, schedule: state.backupSchedule }); }
      if (method === "PUT") {
        const input = await body<{ enabled: boolean; intervalHours: number; retention: number; mode?: "copy" | "incremental" }>(req);
        if (typeof input.enabled !== "boolean" || !Number.isInteger(input.intervalHours) || input.intervalHours < 1 || input.intervalHours > 168 || !Number.isInteger(input.retention) || input.retention < 1 || input.retention > 500) throw new HttpError(400, "Choose an interval of 1–168 hours and keep 1–500 scheduled backups.");
        if (input.mode !== undefined && input.mode !== "copy" && input.mode !== "incremental") throw new HttpError(400, "Choose full copies or incremental backups.");
        await withServerLock(id, "saving backup policy", async () => {
          await changeControl(id, (state) => { state.backupPolicy = { ...state.backupPolicy, enabled: input.enabled, intervalHours: input.intervalHours, retention: input.retention, mode: input.mode ?? state.backupPolicy.mode ?? "copy" }; });
          await recordEvent(id, "Automatic backup policy updated.");
        });
        return json(res, 200, { ok: true });
      }
    }
    if (action === "backup-maintenance" && method === "POST") {
      const input = await body<{ prune?: boolean }>(req);
      if (input.prune !== undefined && typeof input.prune !== "boolean") throw new HttpError(400, "Invalid maintenance request.");
      await withServerLock(id, "backup repository maintenance", () => maintainRepository(id, input.prune === true));
      await recordEvent(id, input.prune ? "Unused backup data reclaimed." : "Encrypted backup repository checked.", "success");
      return json(res, 200, { ok: true });
    }
    if (action === "files") {
      const requested = userPath(url.searchParams.get("path") || "");
      return withServerLock(id, "managing files", async () => {
        if (method === "GET") return json(res, 200, url.searchParams.get("text") === "1" ? await readText(id, requested) : { entries: (await listFiles(id, requested)).filter((entry) => !entry.name.toLowerCase().startsWith(".blocky-")) });
        if (method === "PUT") {
          const input = await body<{ path: string; content: string; modifiedAt?: string; revision?: string }>(req, MAX_TEXT_BYTES * 6 + 65536);
          if (input.modifiedAt !== undefined && typeof input.modifiedAt !== "string") throw new HttpError(400, "Invalid file revision.");
          if (input.revision !== undefined && (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision))) throw new HttpError(400, "Invalid file revision.");
          await writeText(id, userPath(input.path), input.content, input.modifiedAt, input.revision);
        } else if (method === "POST") { const input = await body<{ path: string }>(req); await makeDirectory(id, userPath(input.path)); }
        else if (method === "PATCH") { const input = await body<{ path: string; destination: string }>(req); await renameFile(id, userPath(input.path), userPath(input.destination)); }
        else if (method === "DELETE") await deleteFile(id, requested);
        else throw new HttpError(405, "Unsupported file operation.");
        await recordEvent(id, `File manager: ${method === "PUT" ? "text file saved" : method === "POST" ? "folder created" : method === "PATCH" ? "entry renamed" : "entry deleted"}.`);
        return json(res, 200, { ok: true });
      });
    }
    if (action === "upload" && method === "POST") {
      await withServerLock(id, "uploading file", () => uploadFile(id, userPath(url.searchParams.get("path") || ""), req));
      await recordEvent(id, "File uploaded.");
      return json(res, 201, { ok: true });
    }
    if (action === "download" && method === "GET") {
      return withServerLock(id, "downloading file", async () => {
        const { handle, size, name } = await openDownload(id, userPath(url.searchParams.get("path") || ""));
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
        try { await pipeline(handle.createReadStream(), res); } finally { await handle.close(); }
      });
    }
    if (action === "open-folder" && method === "POST") {
      execFile("explorer.exe", [serverDir(id)], { windowsHide: false }, () => undefined);
      return json(res, 200, { ok: true });
    }
    if (action === "backups") {
      const name = parts[4];
      if (!name && method === "GET") return json(res, 200, { backups: await listBackups(id) });
      if (!name && method === "POST") {
        const created = await withServerLock(id, "creating backup", async () => { const name = await createBackup(id); await copyOffsiteAfterBackup(id); return name; });
        await recordEvent(id, "Manual backup created.", "success"); return json(res, 201, { name: created });
      }
      if (name && parts[5] === "restore" && method === "POST") { await withServerLock(id, "restoring backup", () => restoreBackup(id, name)); await recordEvent(id, "Backup restored; a safety copy was saved.", "success"); return json(res, 200, { ok: true }); }
      if (name && !parts[5] && method === "DELETE") { await withServerLock(id, "deleting backup", () => deleteBackup(id, name)); await recordEvent(id, "Backup deleted."); return json(res, 200, { ok: true }); }
    }
  }
  throw new HttpError(404, "Not found.");
}

/**
 * Only this machine can reach the panel (it listens on 127.0.0.1), and two checks keep web pages
 * from using your browser to reach it: the Host header must be this address (no DNS rebinding),
 * and changes need a custom header a cross-site page can't send without a CORS preflight, which
 * this server never approves.
 */
export function createServer(port: number) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "Open Blocky Panel at http://127.0.0.1:" + port);
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(req.headers.origin)) throw new HttpError(403, "Open the panel on this computer to use its API.");
        if (req.method !== "GET" && req.headers["x-blocky-request"] !== "1") throw new HttpError(403, "Missing request verification header.");
        return await route(req, res, url);
      }
      const name = url.pathname === "/" ? "index.html" : STATIC.test(url.pathname) ? url.pathname.slice(1) : undefined;
      let file = name ? await asset(name) : undefined;
      if (!file) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found."); }
      if (name === "index.html") file = Buffer.from(file.toString("utf8").replace(/(src|href)="\/(app\.js|app\.css|theme\.js)"/g, (_match, attribute: string, filename: string) => `${attribute}="/${filename}?build=${encodeURIComponent(UI_BUILD)}"`));
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(name!)] ?? "application/octet-stream",
        "Cache-Control": name === "index.html" ? "no-store" : /\.(js|css)$/.test(name!) ? "no-cache" : "max-age=3600",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
        ...(name === "index.html" ? { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } : {}),
      });
      res.end(file);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: error instanceof Error ? error.message : "Something went wrong." });
      else res.end();
    }
  });
}
