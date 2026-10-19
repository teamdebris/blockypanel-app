import http from "node:http";
import os from "node:os";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { rm } from "node:fs/promises";
import { createBackup, deleteBackup, listBackups, restoreBackup } from "./backups";
import { consoleLines, events, isActive, restart, runtimeInfo, sendCommand, start, stop, type Line } from "./minecraft";
import { backupDir, DATA_ROOT, serverDir } from "./paths";
import { versions } from "./software";
import { addServer, type Difficulty, getServer, ICONS, loadServers, removeServer, type Software, updateServer } from "./store";

import release from "../../../package.json";

export const VERSION = release.version;

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

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

async function body<T>(req: http.IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new HttpError(413, "That request is too large."); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T; } catch { throw new HttpError(400, "That request isn't valid JSON."); }
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
  return { ...config, ...runtimeInfo(id), address: `${lanAddress()}:${config.port}` };
}

const MEMORY = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384];
const DIFFICULTIES: Difficulty[] = ["peaceful", "easy", "normal", "hard"];

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
  if (url.pathname === "/api/state" && method === "GET") {
    const servers = await Promise.all((await loadServers()).map((server) => summary(server.id)));
    return json(res, 200, { version: VERSION, dataRoot: DATA_ROOT, servers });
  }
  if (url.pathname === "/api/versions" && method === "GET") {
    const software = url.searchParams.get("software") === "vanilla" ? "vanilla" : "paper";
    return json(res, 200, { versions: await versions(software) });
  }
  if (url.pathname === "/api/servers" && method === "POST") {
    const input = await body<Record<string, unknown>>(req);
    if (input.eula !== true) throw new HttpError(400, "Accept the Minecraft EULA to create a server.");
    const software: Software = input.software === "vanilla" ? "vanilla" : "paper";
    const version = String(input.version ?? "");
    if (!/^\d+(\.\d+)+$/.test(version)) throw new HttpError(400, "Pick a Minecraft version.");
    const settings = validSettings(input, true);
    if (await portInUse(settings.port as number)) throw new HttpError(409, `Another server already uses port ${settings.port}.`);
    const icons = ["grass", "stone", "sand", "snow", "oak-log", "dirt", "water", "copper-ore"];
    const server = await addServer({ software, version, motd: `${settings.name} · a Blocky server`, maxPlayers: 10, difficulty: "normal", icon: icons[(await loadServers()).length % icons.length], ...settings } as Parameters<typeof addServer>[0]);
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
      await updateServer(id, settings);
      return json(res, 200, { ...(await summary(id)), restartNeeded: isActive(id) && Object.keys(settings).some((key) => key !== "name" && key !== "icon") });
    }
    if (!action && method === "DELETE") {
      if (isActive(id)) throw new HttpError(409, "Stop the server before deleting it.");
      await removeServer(id);
      await rm(serverDir(id), { recursive: true, force: true });
      await rm(backupDir(id), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && (action === "start" || action === "stop" || action === "restart")) {
      // Starting can take minutes the first time (downloads); the UI follows along on the console.
      const work = action === "start" ? start(config) : action === "stop" ? stop(id) : restart(config);
      work.catch(() => undefined);
      return json(res, 202, { ok: true });
    }
    if (action === "command" && method === "POST") {
      const { command } = await body<{ command?: string }>(req);
      if (!command || command.length > 512) throw new HttpError(400, "Type a command.");
      sendCommand(id, command);
      return json(res, 200, { ok: true });
    }
    if (action === "console" && method === "GET") return consoleStream(req, res, id);
    if (action === "open-folder" && method === "POST") {
      execFile("explorer.exe", [serverDir(id)], { windowsHide: false }, () => undefined);
      return json(res, 200, { ok: true });
    }
    if (action === "backups") {
      const name = parts[4];
      if (!name && method === "GET") return json(res, 200, { backups: await listBackups(id) });
      if (!name && method === "POST") return json(res, 201, { name: await createBackup(id) });
      if (name && parts[5] === "restore" && method === "POST") { await restoreBackup(id, name); return json(res, 200, { ok: true }); }
      if (name && !parts[5] && method === "DELETE") { await deleteBackup(id, name); return json(res, 200, { ok: true }); }
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
        if (req.method !== "GET" && req.headers["x-blocky-request"] !== "1") throw new HttpError(403, "Missing request verification header.");
        return await route(req, res, url);
      }
      const name = url.pathname === "/" ? "index.html" : STATIC.test(url.pathname) ? url.pathname.slice(1) : undefined;
      const file = name ? await asset(name) : undefined;
      if (!file) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found."); }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(name!)] ?? "application/octet-stream",
        "Cache-Control": name === "index.html" ? "no-store" : "max-age=3600",
        "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
        ...(name === "index.html" ? { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } : {}),
      });
      res.end(file);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: error instanceof Error ? error.message : "Something went wrong." });
      else res.end();
    }
  });
}
