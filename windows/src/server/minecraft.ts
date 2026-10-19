import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { serverDir } from "./paths";
import { downloadServerJar, ensureJava, javaFor } from "./software";
import type { ServerConfig } from "./store";
import { recordEvent } from "./control";
import { parseSeedReply } from "../../../lib/chunkbase";
import { prepareLoader, stopLoaderInstallers } from "./loaders";
import { stopRestic } from "./restic";

export type Status = "stopped" | "installing" | "starting" | "running" | "stopping" | "crashed";
export type Line = { at: number; text: string; kind: "out" | "err" | "command" | "panel" };

type Runtime = {
  status: Status; process?: ChildProcessWithoutNullStreams; lines: Line[]; players: Set<string>;
  step?: string; progress?: number; startedAt?: number; memoryUsedMb?: number; stopping?: boolean; lastError?: string;
};

const MAX_LINES = 1000;
const runtimes = new Map<string, Runtime>();
let shuttingDown = false;
/** "line" (id, Line) and "change" (id) events, for the console streams and the UI. */
export const events = new EventEmitter();
events.setMaxListeners(200);

function runtime(id: string) {
  let value = runtimes.get(id);
  if (!value) { value = { status: "stopped", lines: [], players: new Set() }; runtimes.set(id, value); }
  return value;
}

function push(id: string, text: string, kind: Line["kind"]) {
  const state = runtime(id);
  const line = { at: Date.now(), text, kind };
  state.lines.push(line);
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  events.emit("line", id, line);
}

function setStatus(id: string, status: Status, extra: Partial<Runtime> = {}) {
  Object.assign(runtime(id), { status, ...extra });
  events.emit("change", id);
}

export function runtimeInfo(id: string) {
  const state = runtime(id);
  return { status: state.status, step: state.step, progress: state.progress, players: [...state.players], startedAt: state.startedAt, memoryUsedMb: state.memoryUsedMb, lastError: state.lastError };
}
export const consoleLines = (id: string) => runtime(id).lines;
export const isActive = (id: string) => ["installing", "starting", "running", "stopping"].includes(runtime(id).status);

const PROPERTIES: [keyof ServerConfig | string, (config: ServerConfig) => string][] = [
  ["server-port", (config) => String(config.port)],
  ["motd", (config) => config.motd.replace(/[\r\n]/g, " ")],
  ["max-players", (config) => String(config.maxPlayers)],
  ["difficulty", (config) => config.difficulty],
  ["gamemode", (config) => config.gameMode],
  ["pvp", (config) => String(config.pvp)],
  ["hardcore", (config) => String(config.hardcore)],
  ["allow-flight", (config) => String(config.allowFlight)],
  ["enable-command-block", (config) => String(config.commandBlocks)],
  ["online-mode", (config) => String(config.onlineMode)],
  ["spawn-protection", (config) => String(config.spawnProtection)],
  ["view-distance", (config) => String(config.viewDistance)],
  ["simulation-distance", (config) => String(config.simulationDistance)],
  ["level-seed", (config) => config.seed],
  // Remote console stays off: the panel talks to the server through its own console.
  ["enable-rcon", () => "false"],
];

/** Writes the panel's settings into server.properties, keeping every other line as it was. */
async function writeProperties(config: ServerConfig) {
  const file = path.join(serverDir(config.id), "server.properties");
  let lines = (await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })).split(/\r?\n/);
  for (const [key, value] of PROPERTIES) {
    const entry = `${key}=${value(config)}`;
    let found = false;
    lines = lines.filter((line) => {
      if (line.trimStart().startsWith("#") || line.trimStart().startsWith("!") || line.split("=", 1)[0].trim() !== key) return true;
      if (found) return false;
      found = true; return true;
    }).map((line) => !line.trimStart().startsWith("#") && !line.trimStart().startsWith("!") && line.split("=", 1)[0].trim() === key ? entry : line);
    if (!found) lines.push(entry);
  }
  await writeFile(file, lines.filter((line, index) => line || index < lines.length - 1).join("\n") + "\n");
}

/** Gets the server ready to run: Java, the server jar, the EULA, and its settings. */
async function prepare(config: ServerConfig) {
  const dir = serverDir(config.id);
  await mkdir(dir, { recursive: true });
  const progress = (step: string) => (fraction: number) => { const state = runtime(config.id); state.step = step; state.progress = fraction; events.emit("change", config.id); };
  const major = await javaFor(config.version);
  setStatus(config.id, "installing", { step: `Getting Java ${major}`, progress: undefined });
  const java = await ensureJava(major, progress(`Downloading Java ${major}`));
  if (["quilt", "forge", "neoforge"].includes(config.software)) {
    const args = await prepareLoader(config.software, config.version, config.id, java, (line) => push(config.id, line, "panel"), (step) => setStatus(config.id, "installing", { step, progress: undefined }));
    await writeFile(path.join(dir, "eula.txt"), "eula=true\n");
    await writeProperties(config);
    return { java, args };
  }
  const jar = path.join(dir, `${config.software}-${config.version}.jar`);
  try { await access(jar); }
  catch {
    const label = config.software[0].toUpperCase() + config.software.slice(1);
    setStatus(config.id, "installing", { step: `Downloading ${label} ${config.version}`, progress: 0 });
    await downloadServerJar(config.software, config.version, jar, progress(`Downloading ${label} ${config.version}`));
  }
  // The EULA was accepted when the server was created.
  await writeFile(path.join(dir, "eula.txt"), "eula=true\n");
  await writeProperties(config);
  return { java, args: ["-jar", path.basename(jar), "nogui"] };
}

export async function start(config: ServerConfig) {
  if (shuttingDown) throw new Error("The panel is shutting down.");
  if (isActive(config.id)) throw new Error("The server is already running.");
  const state = runtime(config.id);
  state.lines = [];
  state.players.clear();
  state.lastError = undefined;
  setStatus(config.id, "installing", { step: "Preparing server", progress: undefined });
  push(config.id, "Getting the server ready…", "panel");
  let prepared: { java: string; args: string[] };
  try { prepared = await prepare(config); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push(config.id, `Couldn't get the server ready: ${message}`, "panel");
    setStatus(config.id, "crashed", { step: undefined, progress: undefined, lastError: message });
    throw error;
  }
  if (shuttingDown) { setStatus(config.id, "stopped", { step: undefined, progress: undefined }); throw new Error("The panel is shutting down."); }
  const child = spawn(prepared.java, [`-Xms${Math.min(1024, config.memoryMb)}M`, `-Xmx${config.memoryMb}M`, ...prepared.args], { cwd: serverDir(config.id), windowsHide: true });
  setStatus(config.id, "starting", { process: child, step: undefined, progress: undefined, startedAt: Date.now(), stopping: false });
  push(config.id, `Starting ${config.software} ${config.version} with ${config.memoryMb / 1024} GB of memory`, "panel");
  const onLine = (kind: "out" | "err") => {
    let rest = "";
    return (chunk: Buffer) => {
      const text = rest + chunk.toString("utf8");
      const parts = text.split(/\r?\n/);
      rest = (parts.pop() ?? "").slice(-8192);
      for (const line of parts) {
        if (!line) continue;
        push(config.id, line.slice(0, 8192), kind);
        if (/Done \([\d.,]+s\)!/.test(line) && runtime(config.id).status === "starting") {
          setStatus(config.id, "running");
          void recordEvent(config.id, "Minecraft server is ready.", "success").catch(console.error);
        }
        const joined = line.match(/: ([A-Za-z0-9_]{1,16}) joined the game/);
        const left = line.match(/: ([A-Za-z0-9_]{1,16}) left the game/);
        if (joined) { runtime(config.id).players.add(joined[1]); events.emit("change", config.id); }
        if (left) { runtime(config.id).players.delete(left[1]); events.emit("change", config.id); }
      }
    };
  };
  child.stdout.on("data", onLine("out"));
  child.stderr.on("data", onLine("err"));
  child.on("exit", (code) => {
    const wanted = runtime(config.id).stopping;
    push(config.id, wanted || code === 0 ? "The server stopped." : `The server stopped unexpectedly (exit code ${code}).`, "panel");
    setStatus(config.id, wanted || code === 0 ? "stopped" : "crashed", { process: undefined, startedAt: undefined, memoryUsedMb: undefined, lastError: wanted || code === 0 ? undefined : `Exit code ${code}` });
    runtime(config.id).players.clear();
    void recordEvent(config.id, wanted || code === 0 ? "Minecraft server stopped." : `Minecraft server exited unexpectedly (${code}).`, wanted || code === 0 ? "info" : "error").catch(console.error);
  });
  child.on("error", (error) => { push(config.id, `Java couldn't start: ${error.message}`, "panel"); setStatus(config.id, "crashed", { process: undefined, lastError: error.message }); });
}

/** Asks the server to save and stop; ends it if it hasn't after `graceMs`. */
export async function stop(id: string, graceMs = 45_000) {
  const state = runtime(id);
  const child = state.process;
  if (!child || state.status === "stopped") return;
  state.stopping = true;
  setStatus(id, "stopping");
  child.stdin.write("stop\n");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs).unref());
  if (await Promise.race([exited, timer]) === "timeout") {
    push(id, "The server didn't stop in time, so it was ended.", "panel");
    child.kill();
    await exited;
  }
}

export async function restart(config: ServerConfig) {
  await stop(config.id);
  await start(config);
}

export function sendCommand(id: string, command: string) {
  const child = runtime(id).process;
  if (!child || !["starting", "running"].includes(runtime(id).status)) throw new Error("The server isn't running.");
  const clean = command.replace(/^\//, "").replace(/[\r\n]/g, " ").trim();
  if (!clean) return;
  push(id, `> ${clean}`, "command");
  child.stdin.write(`${clean}\n`);
}

export async function querySeed(id: string): Promise<string> {
  if (runtime(id).status !== "running") throw new Error("Start the server before reading its world seed.");
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); events.off("line", onLine); };
    const onLine = (serverId: string, line: Line) => {
      if (serverId !== id || line.kind === "command") return;
      const seed = parseSeedReply(line.text);
      if (seed) { cleanup(); resolve(seed); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("The server did not answer the seed command. Try again in a moment.")); }, 10000);
    events.on("line", onLine);
    try { sendCommand(id, "seed"); } catch (error) { cleanup(); reject(error); }
  });
}

/** Memory in use by each running server's Java process, from Windows' task list every few seconds. */
setInterval(() => {
  for (const [id, state] of runtimes) {
    const pid = state.process?.pid;
    if (!pid) continue;
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
      const kb = Number(stdout.split('","')[4]?.replace(/[^\d]/g, ""));
      if (!error && kb) { state.memoryUsedMb = Math.round(kb / 1024); events.emit("change", id); }
    });
  }
}, 5000).unref();

/** Stops every running server, for when the panel closes. */
export async function stopAll(graceMs = 20_000) {
  shuttingDown = true;
  stopLoaderInstallers();
  stopRestic();
  await Promise.all([...runtimes.keys()].map((id) => stop(id, graceMs).catch(() => undefined)));
}
