import "server-only";

import { chmod, chown, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Docker, { Container, ContainerCreateOptions, ContainerInfo } from "dockerode";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import {
  checkIncrementalRepository, createIncrementalSnapshot, forgetIncrementalSnapshots, getIncrementalSnapshot,
  incrementalBackupRecord, listIncrementalSnapshots, pruneIncrementalRepository, restoreIncrementalSnapshot,
} from "@/lib/incremental-backups";
import { offsiteSettings, serverOffsiteStatus } from "@/lib/offsite-settings";
import { activeOperation, type ActiveOperation, type FinishedOperation, lastOperation, setOperationStep, startServerOperation, withServerLock } from "@/lib/operations";
import { assertServerId, dockerServerDataPath, isServerId, serverBackupPath, serverDataPath, serverMetaPath, serverRootPath, STORAGE_ROOT, storagePath } from "@/lib/paths";
import { isModrinthId, modrinthEnv } from "@/lib/modrinth-core";
import { parsePlayerList, parseStatusCount } from "@/lib/players";
import { levelName, withProperty, worldFolders } from "@/lib/world";
import { snapshotsToForget } from "@/lib/retention";
import { scheduledBackupDue, shouldAlertFailure, waitingForStartup } from "@/lib/schedule";
import { getServerControl, markBackupRun, markMaintenance, markScheduledAttempt, recordEvent, recordObservedStatus, removeServerControl } from "@/lib/store";
import { GAME_MODES, JAVA_VERSIONS, managedPropertyKeys, SERVER_TYPES, updateServerSchema } from "@/lib/validation";

const docker = new Docker();
const IMAGE = process.env.MINECRAFT_IMAGE || "itzg/minecraft-server:latest";
const MANAGED_LABEL = "panel.managed";
const STARTUP_TIMEOUT_MS = Number(process.env.BLOCKY_STARTUP_TIMEOUT_SECONDS || 180) * 1000;
const DOCKER_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const isDemo = () => process.env.BLOCKY_DEMO === "true";
// Hostname players connect to (e.g. play.example.com). Empty means the UI uses the panel's own hostname.
const PUBLIC_HOST = (process.env.BLOCKY_PUBLIC_HOST || "").trim();

type ServerType = (typeof SERVER_TYPES)[number];
type GameMode = (typeof GAME_MODES)[number];
type JavaVersion = (typeof JAVA_VERSIONS)[number];

type ServerConfig = {
  name: string;
  type: ServerType;
  version: string;
  javaVersion: JavaVersion;
  memory: string;
  cpuLimit: number;
  port: number;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  maxPlayers: number;
  whitelist: string[];
  seed: string;
  motd: string;
  customProperties: string;
  initialMemoryPercent: number;
  maxMemoryPercent: number;
  rollingLogMaxFiles: number;
  viewDistance: number;
  simulationDistance: number;
  stopAnnounceDelaySeconds: number;
  useMeowiceFlags: boolean;
  pauseWhenEmptySeconds: number;
  modrinthProjects: string[];
  gameMode: GameMode;
  pvp: boolean;
  hardcore: boolean;
  allowFlight: boolean;
  commandBlocks: boolean;
  onlineMode: boolean;
  spawnProtection: number;
};

type CreateServerInput = ServerConfig & { eula: boolean };

type ServerMeta = ServerConfig & {
  id: string;
  createdAt: string;
  dataPath: string;
};

type ServerSummary = ServerMeta & {
  status: "running" | "starting" | "stopped" | "failed";
  health: string;
  statusMessage: string;
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  diskUsageBytes: number;
  playersOnline: number;
  players: string[];
  restartCount: number;
  backupCount: number;
  operation?: ActiveOperation;
  lastOperation?: FinishedOperation;
  backup?: { enabled: boolean; intervalHours: number; lastRunAt?: string; consecutiveFailures: number };
  offsite?: { lastCopyAt?: string; lastError?: string };
  image?: string;
};

type BackupRecord = {
  name: string;
  size: number;
  createdAt: string;
  kind: string;
  logicalSize?: number;
};

type DetachedWorld = {
  id: string;
  name: string;
  diskUsageBytes: number;
  hasData: boolean;
  hasBackups: boolean;
  canReattach: boolean;
  config?: ServerMeta;
};

type DemoState = { servers: ServerSummary[]; logs: Record<string, string[]>; backups: Record<string, BackupRecord[]> };
type RuntimeMetric = { at: number; playersOnline: number; players: string[]; namesAt?: number };
const runtimeMetrics = new Map<string, RuntimeMetric>();
const backupCounts = new Map<string, { at: number; count: number }>();
// Each listing runs restic; share one result for a few seconds so opening the Backups tab (any role
// can) can't start an unbounded number of restic processes.
const backupLists = new Map<string, { at: number; promise: Promise<BackupRecord[]> }>();

function forgetBackupList(id: string) {
  backupCounts.delete(id);
  backupLists.delete(id);
}
const diskUsage = new Map<string, { at: number; bytes: number; pending?: Promise<number> }>();
const pendingCreations = new Map<string, ServerSummary>();
const metaWritten = new Set<string>();
let serverListCache: { at: number; value?: ServerSummary[]; pending?: Promise<ServerSummary[]> } = { at: 0 };
// Bumped whenever servers are added or removed, so a collection that started earlier can't be cached or shared.
let serverListGeneration = 0;
const demoGlobal = globalThis as typeof globalThis & { __blockyDemo?: DemoState };

const demoDefaults = { javaVersion: "auto" as const, cpuLimit: 0, players: [] as string[], whitelist: [] as string[], seed: "", customProperties: "", initialMemoryPercent: 25, maxMemoryPercent: 75, rollingLogMaxFiles: 30, viewDistance: 8, simulationDistance: 6, stopAnnounceDelaySeconds: 10, useMeowiceFlags: true, pauseWhenEmptySeconds: 300, modrinthProjects: [] as string[], gameMode: "survival" as const, pvp: true, hardcore: false, allowFlight: false, commandBlocks: false, onlineMode: true, spawnProtection: 16 };

function demoState(): DemoState {
  demoGlobal.__blockyDemo ??= {
    servers: [
      { ...demoDefaults, id: "a7c31e481f20", name: "Survival Realm", status: "running", health: "healthy", statusMessage: "Ready for players", type: "PAPER", version: "1.21.8", memory: "6G", port: 25565, maxPlayers: 24, difficulty: "hard", whitelist: ["Steve"], motd: "Welcome to Survival Realm", createdAt: "2026-09-18T14:22:00.000Z", dataPath: "storage/servers/demo-survival/data", cpuPercent: 18.4, memoryUsageMb: 2847, memoryLimitMb: 6144, diskUsageBytes: 2_483_212_800, playersOnline: 3, players: ["Steve", "Alex", "Noor"], restartCount: 2, backupCount: 2 },
      { ...demoDefaults, id: "f2089bdc610a", name: "Creative Lab", status: "stopped", health: "stopped", statusMessage: "Stopped by administrator", type: "PURPUR", version: "1.21.8", memory: "4G", port: 25566, maxPlayers: 12, difficulty: "normal", motd: "Creative Lab", createdAt: "2026-09-11T09:10:00.000Z", dataPath: "storage/servers/demo-creative/data", cpuPercent: 0, memoryUsageMb: 0, memoryLimitMb: 4096, diskUsageBytes: 786_432_000, playersOnline: 0, restartCount: 0, backupCount: 1 },
    ],
    logs: {
      a7c31e481f20: ["[Server thread/INFO]: Done (4.821s)! For help, type \"help\"", "[Server thread/INFO]: Steve joined the game", "[Server thread/INFO]: Saving the game (this may take a moment!)"],
      f2089bdc610a: ["[Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved", "[Server thread/INFO]: Closing Server"],
    },
    backups: {
      a7c31e481f20: [
        { name: `snapshot-${"a1".repeat(32)}`, size: 48_211_968, logicalSize: 2_483_212_800, createdAt: "2026-09-21T12:00:00.000Z", kind: "scheduled" },
        { name: `snapshot-${"b2".repeat(32)}`, size: 2_451_120_128, logicalSize: 2_451_120_128, createdAt: "2026-09-20T18:30:00.000Z", kind: "manual" },
      ],
      f2089bdc610a: [{ name: `snapshot-${"c3".repeat(32)}`, size: 786_432_000, logicalSize: 786_432_000, createdAt: "2026-09-20T12:00:00.000Z", kind: "scheduled" }],
    },
  };
  for (const server of demoGlobal.__blockyDemo.servers) Object.assign(server, { ...demoDefaults, ...server });
  return demoGlobal.__blockyDemo;
}

/** Demo mode runs fake background operations through the real registry so progress UI can be exercised. */
function demoOperation(id: string, kind: Parameters<typeof startServerOperation>[1], label: string, steps: string[], finish: () => Promise<void>) {
  return startServerOperation(id, kind, label, async () => {
    for (const step of steps) {
      setOperationStep(id, step);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await finish();
  });
}

function demoServer(id: string) {
  const server = demoState().servers.find((candidate) => candidate.id === id);
  if (!server) throw new NotFoundError("Server not found.");
  return server;
}

/** Bounds Docker API calls that should be quick, so a hung daemon can't hang every request. */
async function timed<T>(promise: Promise<T>, label: string, ms = DOCKER_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Docker did not respond to ${label} within ${ms / 1000}s.`)), ms); })]);
  } finally { clearTimeout(timer); }
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 36) || "server";
}

function bytesFor(memory: string) {
  const match = memory.match(/^(\d+)([GM])$/i);
  if (!match) return 4 * 1024 ** 3;
  return Number(match[1]) * (match[2].toUpperCase() === "G" ? 1024 ** 3 : 1024 ** 2);
}

/** Picks the itzg image tag for a Java version, keeping the configured repository (and registry). */
function imageFor(meta: Pick<ServerMeta, "javaVersion">) {
  if (!meta.javaVersion || meta.javaVersion === "auto") return IMAGE;
  const slash = IMAGE.lastIndexOf("/");
  const colon = IMAGE.lastIndexOf(":");
  const repository = colon > slash ? IMAGE.slice(0, colon) : IMAGE;
  return `${repository}:java${meta.javaVersion}`;
}

function encodeList(value: string[]) {
  return JSON.stringify(value);
}

function decodeList(value?: string) {
  if (!value) return [];
  try { return JSON.parse(value) as string[]; } catch { return value.split(",").map((item) => item.trim()).filter(Boolean); }
}

function customPropertiesWithoutManagedValues(value: string) {
  return value.split("\n").filter((line) => {
    const separator = line.indexOf("=");
    if (separator === -1) return true;
    return !managedPropertyKeys.has(line.slice(0, separator).trim().toLowerCase());
  }).join("\n").trim();
}

/**
 * A gameplay setting from its label, or, for servers created before it had a control, from the
 * custom server.properties it may have been typed into.
 */
function gameplaySetting(labels: Record<string, string>, label: string, property: string) {
  if (labels[label] !== undefined) return labels[label];
  const line = (labels["panel.customProperties"] || "").split("\n").find((item) => item.split("=", 1)[0].trim().toLowerCase() === property);
  return line === undefined ? undefined : line.slice(line.indexOf("=") + 1).trim();
}

function metaFromLabels(labels: Record<string, string>): ServerMeta {
  const type = labels["panel.type"] as ServerType;
  const setting = (label: string, property: string) => gameplaySetting(labels, `panel.${label}`, property);
  const flag = (label: string, property: string, fallback: boolean) => { const value = setting(label, property); return value === undefined ? fallback : value.toLowerCase() === "true"; };
  const gameMode = setting("gameMode", "gamemode")?.toLowerCase() as GameMode;
  const spawnProtection = Number(setting("spawnProtection", "spawn-protection") ?? 16);
  const javaVersion = labels["panel.javaVersion"] as JavaVersion;
  return {
    id: labels["panel.id"],
    name: labels["panel.name"],
    type: SERVER_TYPES.includes(type) ? type : "PAPER",
    version: labels["panel.version"] || "LATEST",
    javaVersion: JAVA_VERSIONS.includes(javaVersion) ? javaVersion : "auto",
    memory: labels["panel.memory"] || "4G",
    cpuLimit: Number(labels["panel.cpuLimit"] || 0),
    port: Number(labels["panel.port"] || 25565),
    difficulty: (labels["panel.difficulty"] || "normal") as ServerMeta["difficulty"],
    maxPlayers: Number(labels["panel.maxPlayers"] || 20),
    whitelist: decodeList(labels["panel.whitelist"]),
    seed: labels["panel.seed"] || "",
    motd: labels["panel.motd"] || "A Minecraft Server powered by Blocky",
    customProperties: customPropertiesWithoutManagedValues(labels["panel.customProperties"] || ""),
    initialMemoryPercent: Number(labels["panel.initialMemoryPercent"] || 25),
    maxMemoryPercent: Number(labels["panel.maxMemoryPercent"] || 75),
    rollingLogMaxFiles: Number(labels["panel.rollingLogMaxFiles"] || 30),
    viewDistance: Number(labels["panel.viewDistance"] || 8),
    simulationDistance: Number(labels["panel.simulationDistance"] || 6),
    stopAnnounceDelaySeconds: Number(labels["panel.stopAnnounceDelaySeconds"] || 10),
    useMeowiceFlags: labels["panel.useMeowiceFlags"] !== "false",
    pauseWhenEmptySeconds: Number(labels["panel.pauseWhenEmptySeconds"] || 300),
    modrinthProjects: decodeList(labels["panel.modrinthProjects"]).filter(isModrinthId),
    gameMode: GAME_MODES.includes(gameMode) ? gameMode : "survival",
    pvp: flag("pvp", "pvp", true),
    hardcore: flag("hardcore", "hardcore", false),
    allowFlight: flag("allowFlight", "allow-flight", false),
    commandBlocks: flag("commandBlocks", "enable-command-block", false),
    onlineMode: flag("onlineMode", "online-mode", true),
    spawnProtection: Number.isInteger(spawnProtection) && spawnProtection >= 0 ? Math.min(spawnProtection, 1000) : 16,
    createdAt: labels["panel.createdAt"] || new Date().toISOString(),
    dataPath: labels["panel.dataPath"],
  };
}

function labelsFor(meta: ServerMeta) {
  return {
    [MANAGED_LABEL]: "true",
    "panel.id": meta.id,
    "panel.name": meta.name,
    "panel.type": meta.type,
    "panel.version": meta.version,
    "panel.javaVersion": meta.javaVersion,
    "panel.memory": meta.memory,
    "panel.cpuLimit": String(meta.cpuLimit),
    "panel.port": String(meta.port),
    "panel.difficulty": meta.difficulty,
    "panel.maxPlayers": String(meta.maxPlayers),
    "panel.whitelist": encodeList(meta.whitelist),
    "panel.seed": meta.seed,
    "panel.motd": meta.motd,
    "panel.customProperties": customPropertiesWithoutManagedValues(meta.customProperties),
    "panel.initialMemoryPercent": String(meta.initialMemoryPercent),
    "panel.maxMemoryPercent": String(meta.maxMemoryPercent),
    "panel.rollingLogMaxFiles": String(meta.rollingLogMaxFiles),
    "panel.viewDistance": String(meta.viewDistance),
    "panel.simulationDistance": String(meta.simulationDistance),
    "panel.stopAnnounceDelaySeconds": String(meta.stopAnnounceDelaySeconds),
    "panel.useMeowiceFlags": String(meta.useMeowiceFlags),
    "panel.pauseWhenEmptySeconds": String(meta.pauseWhenEmptySeconds),
    "panel.modrinthProjects": encodeList(meta.modrinthProjects ?? []),
    "panel.gameMode": meta.gameMode,
    "panel.pvp": String(meta.pvp),
    "panel.hardcore": String(meta.hardcore),
    "panel.allowFlight": String(meta.allowFlight),
    "panel.commandBlocks": String(meta.commandBlocks),
    "panel.onlineMode": String(meta.onlineMode),
    "panel.spawnProtection": String(meta.spawnProtection),
    "panel.createdAt": meta.createdAt,
    "panel.dataPath": meta.dataPath,
    // Only Minecraft is supported; the label lets the panel skip containers of other games.
    "panel.game": "minecraft",
  };
}

function createOptions(meta: ServerMeta, rconPassword = randomBytes(24).toString("base64url"), image = imageFor(meta)): ContainerCreateOptions {
  const env = [
    "EULA=TRUE", `TYPE=${meta.type}`, `VERSION=${meta.version}`,
    `INIT_MEMORY=${meta.initialMemoryPercent}%`, `MAX_MEMORY=${meta.maxMemoryPercent}%`,
    `DIFFICULTY=${meta.difficulty}`, `MAX_PLAYERS=${meta.maxPlayers}`, `MOTD=${meta.motd}`,
    "ENABLE_RCON=TRUE", `RCON_PASSWORD=${rconPassword}`, "CREATE_CONSOLE_IN_PIPE=TRUE",
    "ENABLE_QUERY=TRUE", "ENABLE_AUTOPAUSE=FALSE",
    `ROLLING_LOG_MAX_FILES=${meta.rollingLogMaxFiles}`, `VIEW_DISTANCE=${meta.viewDistance}`,
    `SIMULATION_DISTANCE=${meta.simulationDistance}`, `STOP_SERVER_ANNOUNCE_DELAY=${meta.stopAnnounceDelaySeconds}`,
    `USE_MEOWICE_FLAGS=${meta.useMeowiceFlags ? "TRUE" : "FALSE"}`,
    `PAUSE_WHEN_EMPTY_SECONDS=${meta.pauseWhenEmptySeconds}`,
    `MODE=${meta.gameMode}`, `PVP=${meta.pvp}`, `HARDCORE=${meta.hardcore}`,
    `ALLOW_FLIGHT=${meta.allowFlight ? "TRUE" : "FALSE"}`, `ENABLE_COMMAND_BLOCK=${meta.commandBlocks}`,
    `ONLINE_MODE=${meta.onlineMode ? "TRUE" : "FALSE"}`, `SPAWN_PROTECTION=${meta.spawnProtection}`,
    ...modrinthEnv(meta.modrinthProjects ?? []),
  ];
  if (meta.whitelist.length) env.push(`WHITELIST=${meta.whitelist.join(",")}`, "ENFORCE_WHITELIST=TRUE", "OVERRIDE_WHITELIST=TRUE");
  if (meta.seed) env.push(`SEED=${meta.seed}`);
  const customProperties = customPropertiesWithoutManagedValues(meta.customProperties);
  if (customProperties) env.push(`CUSTOM_SERVER_PROPERTIES=${customProperties}`);
  return {
    Image: image,
    name: `blocky-${slugify(meta.name)}-${meta.id.slice(0, 6)}`,
    Tty: true,
    OpenStdin: true,
    Labels: labelsFor(meta),
    Env: env,
    ExposedPorts: { "25565/tcp": {} },
    HostConfig: {
      Binds: [`${meta.dataPath}:/data`],
      PortBindings: { "25565/tcp": [{ HostPort: String(meta.port) }] },
      Memory: bytesFor(meta.memory),
      ...(meta.cpuLimit > 0 ? { NanoCpus: Math.round(meta.cpuLimit * 1e9) } : {}),
      PidsLimit: 4096,
      SecurityOpt: ["no-new-privileges:true"],
      LogConfig: { Type: "json-file", Config: { "max-size": "20m", "max-file": "3" } },
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}

async function pullImage(image: string) {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve()));
}

/**
 * Managed Minecraft containers. Containers labeled with another game (from a build of the panel that
 * runs other games) are ignored rather than misread as Minecraft.
 */
async function managedContainers() {
  const items = await timed(docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } }), "the container list");
  return items.filter((item) => (item.Labels?.["panel.game"] ?? "minecraft") === "minecraft");
}

async function findInfo(id: string) {
  assertServerId(id);
  const item = (await managedContainers()).find((candidate) => candidate.Labels?.["panel.id"] === id);
  if (!item) throw new NotFoundError("Server not found.");
  return item;
}

async function saveServerMeta(meta: ServerMeta) {
  // server.json is the panel's record of a server's settings; only the panel needs to read it.
  // The Minecraft container bind-mounts data/ directly, so it doesn't need this folder open.
  await mkdir(serverRootPath(meta.id), { recursive: true, mode: 0o700 });
  await chmod(serverRootPath(meta.id), 0o700).catch(() => undefined);
  await writeFile(serverMetaPath(meta.id), JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(serverMetaPath(meta.id), 0o600).catch(() => undefined);
  metaWritten.add(meta.id);
}

async function readServerMeta(id: string): Promise<ServerMeta | undefined> {
  try {
    const stored = JSON.parse(await readFile(serverMetaPath(id), "utf8")) as Partial<ServerMeta> & { game?: string };
    if (stored.game !== undefined && stored.game !== "minecraft") return undefined;
    // Defaults (and gameplay settings still in custom properties) from a label-less read, then the saved values.
    return { ...metaFromLabels({ "panel.customProperties": typeof stored.customProperties === "string" ? stored.customProperties : "" }), ...stored, id, dataPath: dockerServerDataPath(id) } as ServerMeta;
  } catch { return undefined; }
}

async function execOutput(container: Container, command: string[], options: { user?: string; workingDir?: string; env?: string[] } = {}) {
  const exec = await container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true, Tty: false, ...(options.user ? { User: options.user } : {}), ...(options.workingDir ? { WorkingDir: options.workingDir } : {}), ...(options.env ? { Env: options.env } : {}) });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errorOutput = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
  container.modem.demuxStream(stream, stdout, stderr);
  await once(stream, "end");
  const result = await exec.inspect();
  if (result.ExitCode && result.ExitCode !== 0) throw new Error(errorOutput.trim() || output.trim() || `Command exited with ${result.ExitCode}.`);
  return output.trim();
}

/**
 * rcon-cli reads options anywhere in its arguments, so a "command" like --host=attacker.example
 * would make it log in to another machine with this server's RCON password. No game command starts
 * with "-", so those are refused outright.
 */
function assertRconCommand(command: string) {
  if (command.trimStart().startsWith("-")) throw new BadRequestError("Commands can't start with \"-\".");
}

async function sendMinecraftCommand(container: Container, command: string) {
  assertRconCommand(command);
  try {
    return await timed(execOutput(container, ["rcon-cli", command]), "an RCON command", 60_000);
  } catch (error) {
    throw new Error(`Could not send "${command}" through RCON: ${error instanceof Error ? error.message : "command failed"}`);
  }
}

async function backupCount(id: string) {
  const cached = backupCounts.get(id);
  if (cached && Date.now() - cached.at < 60_000) return cached.count;
  let count = 0;
  try { count = (await listBackups(id)).length; }
  catch { return cached?.count ?? 0; }
  backupCounts.set(id, { at: Date.now(), count });
  return count;
}

/** Sums file sizes under a directory without following symlinks. */
async function directorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await lstat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** World size, measured from the panel side so it works for stopped servers too. Refreshed every five minutes. */
function worldSize(id: string) {
  const cached = diskUsage.get(id);
  if (cached?.pending) return cached.bytes;
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    const pending = directorySize(serverDataPath(id)).then((bytes) => { diskUsage.set(id, { at: Date.now(), bytes }); return bytes; }).catch(() => { diskUsage.set(id, { at: Date.now(), bytes: cached?.bytes ?? 0 }); return 0; });
    diskUsage.set(id, { at: cached?.at ?? 0, bytes: cached?.bytes ?? 0, pending });
  }
  return diskUsage.get(id)?.bytes ?? 0;
}

async function liveStats(info: ContainerInfo) {
  const fallback = { cpuPercent: 0, memoryUsageMb: 0, memoryLimitMb: Math.round(bytesFor(info.Labels["panel.memory"]) / 1024 ** 2) };
  if (info.State !== "running") return fallback;
  try {
    const stats = await timed(docker.getContainer(info.Id).stats({ stream: false }), "container stats");
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const memoryStats = stats.memory_stats.stats as Record<string, number> | undefined;
    const cache = memoryStats?.total_inactive_file !== undefined
      ? memoryStats.total_inactive_file
      : memoryStats?.inactive_file !== undefined
        ? memoryStats.inactive_file
        : memoryStats?.cache || 0;
    const workingSet = Math.max(0, (stats.memory_stats.usage || 0) - Math.min(cache, stats.memory_stats.usage || 0));
    return {
      cpuPercent: Number((systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0).toFixed(1)),
      memoryUsageMb: Math.round(workingSet / 1024 ** 2),
      memoryLimitMb: Math.round((stats.memory_stats.limit || bytesFor(info.Labels["panel.memory"])) / 1024 ** 2),
    };
  } catch { return fallback; }
}

async function onlinePlayers(info: ContainerInfo) {
  if (info.State !== "running") return { online: 0, names: [] as string[] };
  const cached = runtimeMetrics.get(info.Id);
  if (cached && Date.now() - cached.at < 15_000) return { online: cached.playersOnline, names: cached.players };
  let result = { online: 0, names: [] as string[] };
  try {
    // The count comes from a server-list ping, which Minecraft doesn't log. Every RCON connection is logged
    // ("Thread RCON Client ... started/shutting down"), so names are fetched over RCON only when someone is
    // online, and at most once a minute.
    const container = docker.getContainer(info.Id);
    const online = parseStatusCount(await timed(execOutput(container, ["mc-monitor", "status", "--json", "--timeout", "3s"]), "the player count"));
    const namesFresh = cached?.namesAt && Date.now() - cached.namesAt < 60_000 && cached.playersOnline === online;
    if (!online) result = { online: 0, names: [] };
    else if (namesFresh) result = { online, names: cached.players };
    else {
      const names = await timed(execOutput(container, ["rcon-cli", "list"]), "the player list").then((output) => parsePlayerList(output).names).catch(() => cached?.players || []);
      result = { online, names };
      runtimeMetrics.set(info.Id, { at: Date.now(), playersOnline: online, players: result.names, namesAt: Date.now() });
      return result;
    }
    runtimeMetrics.set(info.Id, { at: Date.now(), playersOnline: online, players: result.names, namesAt: cached?.namesAt });
    return result;
  } catch { /* server still starting */ }
  runtimeMetrics.set(info.Id, { at: Date.now(), playersOnline: result.online, players: result.names });
  return result;
}

function statusFrom(info: ContainerInfo, health: string): ServerSummary["status"] {
  if (info.State === "running") {
    if (health === "starting") return "starting";
    if (health === "unhealthy") return "failed";
    return "running";
  }
  if (info.State === "created" || info.State === "restarting") return "starting";
  if (info.State === "exited" && info.Status?.includes("(0)")) return "stopped";
  return info.State === "exited" || info.State === "dead" ? "failed" : "stopped";
}

function statusMessage(details: Docker.ContainerInspectInfo, status: ServerSummary["status"]) {
  if (status === "running") return "Ready for players";
  if (status === "starting") return details.State.Health?.Log?.at(-1)?.Output?.trim() || "Installing and starting";
  if (status === "failed") return details.State.Error || details.State.Health?.Log?.at(-1)?.Output?.trim() || `Container exited with code ${details.State.ExitCode}.`;
  return "Stopped by administrator";
}

/** Extra details for the UI. */
function describeServer(meta: ServerMeta) {
  return { image: imageFor(meta) };
}

function withOperations<T extends ServerSummary>(summary: T): T {
  return { ...summary, operation: activeOperation(summary.id), lastOperation: lastOperation(summary.id) };
}

export async function getSystem() {
  const offsiteBackups = Boolean(await offsiteSettings().catch(() => undefined));
  if (isDemo()) {
    const state = demoState();
    return { dockerAvailable: true, dockerVersion: "28.3.2", serverCount: state.servers.length, runningCount: state.servers.filter((server) => server.status === "running").length, offsiteBackups, publicHost: PUBLIC_HOST };
  }
  try {
    const [version, items] = await Promise.all([timed(docker.version(), "the version check"), managedContainers()]);
    return { dockerAvailable: true, dockerVersion: version.Version, serverCount: items.length, runningCount: items.filter((item) => item.State === "running").length, offsiteBackups, publicHost: PUBLIC_HOST };
  } catch (error) {
    return { dockerAvailable: false, runningCount: 0, serverCount: 0, offsiteBackups, publicHost: PUBLIC_HOST, error: error instanceof Error ? error.message : "Docker is unavailable." };
  }
}

async function collectServers(): Promise<ServerSummary[]> {
  // Snapshot servers still being created *before* listing containers. A creation that finishes while this
  // collection runs is then covered either by its container (if listed) or by this snapshot.
  const pendingAtStart = [...pendingCreations.values()];
  const items = await managedContainers();
  const summaries = await Promise.all(items.map(async (info) => {
    const meta = metaFromLabels(info.Labels);
    const details = await timed(docker.getContainer(info.Id).inspect(), "a container inspect");
    const health = details.State.Health?.Status || (info.State === "running" ? "running" : "stopped");
    const status = statusFrom(info, health);
    const [stats, players, count] = await Promise.all([liveStats(info), onlinePlayers(info), backupCount(meta.id)]);
    const summary: ServerSummary = { ...meta, ...describeServer(meta), status, health, statusMessage: statusMessage(details, status), ...stats, diskUsageBytes: worldSize(meta.id), playersOnline: players.online, players: players.names, restartCount: details.RestartCount, backupCount: count };
    void recordObservedStatus(meta.id, status, meta.name, details.RestartCount).catch(() => undefined);
    // Servers created before configs were saved to disk get their server.json written once, so they can be reattached later.
    if (!metaWritten.has(meta.id) && isServerId(meta.id)) void saveServerMeta(meta).catch(() => undefined);
    return summary;
  }));
  const existing = new Set(summaries.map((server) => server.id));
  for (const pending of [...pendingAtStart, ...pendingCreations.values()]) if (!existing.has(pending.id)) { summaries.push(pending); existing.add(pending.id); }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Server list shared by concurrent callers (several tabs, the scheduler) and cached briefly. */
export async function listServers(): Promise<ServerSummary[]> {
  let servers: ServerSummary[];
  if (isDemo()) servers = demoState().servers.map((server) => ({ ...server, ...describeServer(server) }));
  else if (serverListCache.value && Date.now() - serverListCache.at < 3000) servers = serverListCache.value;
  else {
    if (!serverListCache.pending) {
      const generation = serverListGeneration;
      const pending = collectServers().then((value) => {
        // Only cache results that are still current; an add or remove in the meantime makes this one stale.
        if (generation === serverListGeneration) serverListCache = { at: Date.now(), value };
        return value;
      }).finally(() => { if (serverListCache.pending === pending) serverListCache.pending = undefined; });
      serverListCache.pending = pending;
    }
    servers = await serverListCache.pending;
  }
  return withBackupHealth(servers.map(withOperations));
}

/** Adds schedule state so the overview can flag servers whose backups are missing or failing. */
async function withBackupHealth(servers: ServerSummary[]) {
  return Promise.all(servers.map(async (server) => {
    const [control, offsite] = await Promise.all([getServerControl(server.id).catch(() => undefined), serverOffsiteStatus(server.id).catch(() => undefined)]);
    if (!control) return server;
    const { enabled, intervalHours, lastRunAt } = control.backupPolicy;
    return { ...server, backup: { enabled, intervalHours, lastRunAt, consecutiveFailures: control.schedule?.consecutiveFailures ?? 0 }, ...(offsite ? { offsite } : {}) };
  }));
}

function invalidateServerList() {
  // Drop the cache and any in-flight collection, so the next caller starts a fresh one that sees the change.
  serverListGeneration += 1;
  serverListCache = { at: 0 };
}

export async function assertManagedServer(id: string) {
  if (isDemo()) { demoServer(id); return; }
  await findInfo(id);
}

/** Rejects a host port that another managed server, or one being created, already uses. */
async function assertPortAvailable(port: number, exceptId?: string) {
  const others: { name: string; port: number }[] = [];
  if (isDemo()) for (const server of demoState().servers) { if (server.id !== exceptId) others.push({ name: server.name, port: server.port }); }
  else {
    for (const item of await managedContainers()) if (item.Labels?.["panel.id"] !== exceptId) { const meta = metaFromLabels(item.Labels); others.push({ name: meta.name, port: meta.port }); }
    for (const server of pendingCreations.values()) if (server.id !== exceptId) others.push({ name: server.name, port: server.port });
  }
  const clash = others.find((other) => other.port === port);
  if (clash) throw new ConflictError(`Port ${port} is already used by ${clash.name}.`);
}

async function provisionContainer(meta: ServerMeta, pending: ServerSummary) {
  pending.statusMessage = `Downloading the server image (${imageFor(meta)})`;
  setOperationStep(meta.id, "Downloading the server image");
  await pullImage(imageFor(meta));
  pending.statusMessage = "Creating container";
  setOperationStep(meta.id, "Creating the container");
  const container = await docker.createContainer(createOptions(meta));
  try {
    await container.start();
  } catch (error) {
    // Leave the world directory and server.json in place so the server can be reattached after fixing the cause.
    await container.remove({ force: true }).catch(() => undefined);
    throw error;
  }
}

function pendingSummary(meta: ServerMeta, message: string): ServerSummary {
  return { ...meta, ...describeServer(meta), status: "starting", health: "starting", statusMessage: message, cpuPercent: 0, memoryUsageMb: 0, memoryLimitMb: Math.round(bytesFor(meta.memory) / 1024 ** 2), diskUsageBytes: 0, playersOnline: 0, players: [], restartCount: 0, backupCount: 0 };
}

/** Registers a new server and provisions its container in the background. */
async function launchNewServer(meta: ServerMeta) {
  await saveServerMeta(meta);
  const pending = pendingSummary(meta, "Queued");
  pendingCreations.set(meta.id, pending);
  invalidateServerList();
  await startServerOperation(meta.id, "create", `Creating ${meta.name}`, async () => {
    try {
      await provisionContainer(meta, pending);
      await recordEvent(meta.id, "create", `${meta.name} was created and started.`, "success");
    } finally {
      pendingCreations.delete(meta.id);
      invalidateServerList();
    }
  });
  return withOperations(pending);
}

export async function createServer(input: CreateServerInput) {
  const config: ServerConfig = { ...input };
  delete (config as Partial<CreateServerInput>).eula;
  if (isDemo()) {
    const state = demoState();
    if (state.servers.some((server) => server.port === input.port)) throw new ConflictError(`Port ${input.port} is already assigned to another managed server.`);
    const id = randomUUID();
    const server: ServerSummary = { ...pendingSummary({ ...config, id, createdAt: new Date().toISOString(), dataPath: `storage/servers/${id}/data` }, "Installing Minecraft"), memoryUsageMb: 384 };
    state.servers.unshift(server); state.logs[id] = ["[Blocky]: Container created", `[Blocky]: Installing ${input.type} ${input.version}...`];
    await recordEvent(id, "create", `${input.name} was created.`, "success");
    setTimeout(() => { server.status = "running"; server.health = "healthy"; server.statusMessage = "Ready for players"; server.cpuPercent = 7.2; server.memoryUsageMb = 1024; state.logs[id].push("[Server thread/INFO]: Done (3.219s)! For help, type \"help\""); }, 1800);
    return server;
  }
  await assertPortAvailable(input.port);
  const id = randomUUID();
  const panelDataPath = serverDataPath(id);
  const meta: ServerMeta = { ...config, id, createdAt: new Date().toISOString(), dataPath: dockerServerDataPath(id) };
  await mkdir(panelDataPath, { recursive: true });
  await chown(panelDataPath, 1000, 1000).catch(() => undefined);
  await chmod(panelDataPath, 0o770).catch(() => undefined);
  return launchNewServer(meta);
}

async function waitUntilReady(container: Container, timeoutMs = STARTUP_TIMEOUT_MS) {
  const started = Date.now();
  let lastMessage = "Server did not become healthy.";
  while (Date.now() - started < timeoutMs) {
    const details = await timed(container.inspect(), "a container inspect");
    if (!details.State.Running) throw new Error(details.State.Error || `Container exited with code ${details.State.ExitCode}.`);
    if (details.State.Health?.Status === "healthy") return;
    if (!details.State.Health) {
      // An image without a health check: ask the server directly.
      try { await timed(execOutput(container, ["mc-monitor", "status", "--timeout", "3s"]), "a health probe"); return; } catch { /* keep waiting */ }
    }
    lastMessage = details.State.Health?.Log?.at(-1)?.Output?.trim() || lastMessage;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(lastMessage);
}

async function stopContainer(container: Container, timeout = 30) {
  const details = await container.inspect();
  if (!details.State.Running && !details.State.Restarting) return;
  try {
    await container.stop({ t: timeout });
  } catch (error) {
    const latest = await container.inspect().catch(() => undefined);
    if (latest?.State.Running || latest?.State.Restarting) throw error;
  }
}

function backupKindLabel(kind: string) {
  if (kind.startsWith("pre-")) return "Safety";
  return kind === "scheduled" ? "Scheduled" : "Manual";
}

function describe(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function replaceServer(info: ContainerInfo, nextMeta: ServerMeta, reason: "settings" | "update") {
  const old = docker.getContainer(info.Id);
  const oldInspect = await old.inspect();
  const oldMeta = metaFromLabels(info.Labels);
  const password = oldInspect.Config.Env?.find((value) => value.startsWith("RCON_PASSWORD="))?.slice("RCON_PASSWORD=".length);
  const wasRestarting = info.State === "restarting" || oldInspect.State.Restarting;
  const oldWasHealthy = oldInspect.State.Health ? oldInspect.State.Health.Status === "healthy" : oldInspect.State.Running && !oldInspect.State.Restarting;
  if (wasRestarting) await stopContainer(old);
  const backupInfo = wasRestarting ? { ...info, State: "exited", Status: "Exited" } : info;
  setOperationStep(oldMeta.id, "Taking a safety backup");
  const safety = await createBackupUnlocked(oldMeta.id, backupInfo, { kind: `pre-${reason}`, prune: false });
  if (!safety.backup) throw new Error("The safety backup was not created.");
  const nextImage = reason === "update" || imageFor(nextMeta) !== imageFor(oldMeta) ? imageFor(nextMeta) : oldInspect.Image;
  const label = "Minecraft";
  if (nextImage !== oldInspect.Image) { setOperationStep(oldMeta.id, "Downloading the server image"); await pullImage(nextImage); }
  let replacement: Container | undefined;
  let removed = false;
  try {
    setOperationStep(oldMeta.id, "Stopping the server");
    await stopContainer(old).catch(async (error) => {
      await recordEvent(oldMeta.id, reason, `Graceful stop failed; removing the already-backed-up container forcefully. ${describe(error, "")}`.trim(), "warning");
    });
    await old.remove({ force: true });
    removed = true;
    setOperationStep(oldMeta.id, "Recreating the container");
    replacement = await docker.createContainer(createOptions(nextMeta, password, nextImage));
    await replacement.start();
    setOperationStep(oldMeta.id, `Waiting for ${label} to start`);
    await waitUntilReady(replacement);
    await saveServerMeta(nextMeta);
    await applyRetention(oldMeta.id, (await getServerControl(oldMeta.id)).backupPolicy.retention);
    await recordEvent(oldMeta.id, reason, reason === "update" ? "Image update completed and health check passed." : "Configuration applied and health check passed.", "success");
  } catch (error) {
    const failure = describe(error, "Operation failed.");
    if (replacement) {
      try { const state = await replacement.inspect(); if (state.State.Running) await replacement.stop({ t: 10 }); } catch { /* already stopped */ }
      await replacement.remove({ force: true }).catch(() => undefined);
    }
    if (!removed) throw error;
    setOperationStep(oldMeta.id, "Startup failed; rolling back");
    try {
      const rollback = await docker.createContainer(createOptions(oldMeta, password, oldInspect.Image));
      await restoreStoredBackup(oldMeta, safety.backup);
      await rollback.start();
      if (oldWasHealthy) await waitUntilReady(rollback);
    } catch (rollbackError) {
      throw new Error(`${failure} Rolling back also failed: ${describe(rollbackError, "unknown error")}. The server needs manual attention; the safety backup ${safety.backup} is intact.`);
    }
    throw new Error(`${failure} The previous container configuration was restored.`);
  } finally {
    invalidateServerList();
  }
}

/**
 * Deletes a Minecraft world (overworld, Nether, End) and starts the server so it generates a new
 * one, with `seed` or a random one. Plugins, mods, configs, the whitelist, and ops are kept. No
 * backup is taken, by design: the confirmation dialog shows when the last one ran.
 */
export async function rerollWorld(id: string, seed: string) {
  if (isDemo()) {
    const server = demoServer(id);
    return demoOperation(id, "reroll", "Re-rolling the world", ["Stopping the server", "Deleting the world", "Generating a new world"], async () => {
      Object.assign(server, { seed, status: "running", health: "healthy", statusMessage: "Ready for players" });
      await recordEvent(id, "reroll", seed ? `World re-rolled with seed ${seed}.` : "World re-rolled with a random seed.", "success");
    });
  }
  const info = await findInfo(id);
  const meta = metaFromLabels(info.Labels);
  // Validated before anything is stopped, so a bad level-name fails without downtime.
  const propertiesFile = path.join(serverDataPath(id), "server.properties");
  const propertiesInfo = await lstat(propertiesFile).catch(() => undefined);
  if (propertiesInfo?.isSymbolicLink()) throw new BadRequestError("server.properties is a symbolic link; fix it before re-rolling.");
  levelName(propertiesInfo ? await readFile(propertiesFile, "utf8") : "");
  return startServerOperation(id, "reroll", "Re-rolling the world", () => rerollUnlocked(info, meta, { ...meta, seed }));
}

async function rerollUnlocked(info: ContainerInfo, oldMeta: ServerMeta, nextMeta: ServerMeta) {
  const id = oldMeta.id;
  const old = docker.getContainer(info.Id);
  const oldInspect = await old.inspect();
  const password = oldInspect.Config.Env?.find((value) => value.startsWith("RCON_PASSWORD="))?.slice("RCON_PASSWORD=".length);
  setOperationStep(id, "Stopping the server");
  await stopContainer(old);

  setOperationStep(id, "Deleting the world");
  const root = serverDataPath(id);
  const propertiesFile = path.join(root, "server.properties");
  const propertiesInfo = await lstat(propertiesFile).catch(() => undefined);
  if (propertiesInfo?.isSymbolicLink()) throw new Error("server.properties is a symbolic link; fix it before re-rolling.");
  const properties = propertiesInfo ? await readFile(propertiesFile, "utf8") : "";
  const level = levelName(properties);
  const deleted: string[] = [];
  for (const folder of worldFolders(level)) {
    const target = path.join(root, folder);
    // rm removes a symlink itself, never what it points to.
    if (!(await lstat(target).catch(() => undefined))) continue;
    await rm(target, { recursive: true, force: true });
    deleted.push(folder);
  }
  // The image only writes level-seed when a seed is set, so an old seed would otherwise stay in
  // server.properties and regenerate the same world.
  if (propertiesInfo) await writeFile(propertiesFile, withProperty(properties, "level-seed", nextMeta.seed));

  let container = old;
  if (nextMeta.seed !== oldMeta.seed) {
    // SEED is container env, so the container is recreated with the new value.
    setOperationStep(id, "Recreating the container");
    await old.remove({ force: true });
    try { container = await docker.createContainer(createOptions(nextMeta, password, oldInspect.Image)); }
    catch (error) {
      // Put the server back (with its old settings) rather than leave it without a container.
      container = await docker.createContainer(createOptions(oldMeta, password, oldInspect.Image));
      throw new Error(`The new container couldn't be created, so the server was recreated with its previous settings (the world is still deleted): ${describe(error, "unknown error")}`);
    }
  }
  await container.start();
  setOperationStep(id, "Generating the new world");
  // A first start generates the world, which can take several minutes on small machines.
  await waitUntilReady(container, Math.max(STARTUP_TIMEOUT_MS, 10 * 60_000));
  await saveServerMeta(nextMeta);
  await recordEvent(id, "reroll", `World re-rolled ${nextMeta.seed ? `with seed ${nextMeta.seed}` : "with a random seed"}. Deleted ${deleted.length ? deleted.join(", ") : "nothing (no world existed yet)"}.`, "success");
}

/** What the Plugins/Mods tab needs to know about a server. */
export async function modrinthServerConfig(id: string) {
  if (isDemo()) { const server = demoServer(id); return { type: server.type, version: server.version, modrinthProjects: server.modrinthProjects || [] }; }
  const meta = metaFromLabels((await findInfo(id)).Labels);
  return { type: meta.type, version: meta.version, modrinthProjects: meta.modrinthProjects };
}

export async function updateServer(id: string, config: ServerConfig) {
  if (isDemo()) {
    const server = demoServer(id);
    return demoOperation(id, "settings", "Applying settings", ["Taking a safety backup", "Recreating the container", "Waiting for Minecraft to start"], async () => {
      Object.assign(server, config, { memoryLimitMb: Math.round(bytesFor(config.memory) / 1024 ** 2), statusMessage: "Ready for players" });
      await recordEvent(id, "settings", "Configuration applied and health check passed.", "success");
    });
  }
  const info = await findInfo(id);
  const current = metaFromLabels(info.Labels);
  await assertPortAvailable(config.port, id);
  return startServerOperation(id, "settings", "Applying settings", () => replaceServer(info, { ...current, ...config }, "settings"));
}

export async function runServerAction(id: string, action: "start" | "stop" | "restart" | "backup" | "update") {
  if (isDemo()) {
    const server = demoServer(id);
    if (action === "backup") return demoOperation(id, "backup", "Backup", ["Saving the world", "Creating the backup"], () => demoBackup(id));
    if (action === "update") return demoOperation(id, "update", "Server software update", ["Taking a safety backup", "Downloading the server image", "Recreating the container", "Waiting for Minecraft to start"], async () => { await recordEvent(id, "update", "Image update completed and health check passed.", "success"); });
    if (["start", "restart"].includes(action)) Object.assign(server, { status: "running", health: "healthy", statusMessage: "Ready for players", cpuPercent: 8.6, memoryUsageMb: server.memoryUsageMb || 1024 });
    else if (action === "stop") Object.assign(server, { status: "stopped", health: "stopped", statusMessage: "Stopped by administrator", cpuPercent: 0, memoryUsageMb: 0, playersOnline: 0, players: [] });
    const state = demoState();
    state.logs[id] ??= []; state.logs[id].push(`[Blocky]: Server ${action} complete`);
    await recordEvent(id, action, `${server.name} ${action} completed.`, "success");
    return { message: `${server.name} ${action === "stop" ? "stopped" : `${action}ed`}.` };
  }
  const info = await findInfo(id);
  const container = docker.getContainer(info.Id);
  const name = info.Labels["panel.name"];
  if (action === "backup") return startServerOperation(id, "backup", "Backup", () => createBackupUnlocked(id, info, { kind: "manual" }));
  if (action === "update") return startServerOperation(id, "update", "Server software update", () => replaceServer(info, metaFromLabels(info.Labels), "update"));
  const labels = { start: "Start", stop: "Stop", restart: "Restart" } as const;
  await withServerLock(id, action, labels[action], async () => {
    if (action === "start") { await container.start(); await recordEvent(id, "start", `${name} was started.`, "success"); }
    else if (action === "stop") { await stopContainer(container); await recordEvent(id, "stop", `${name} was stopped.`, "info"); }
    else { await container.restart({ t: 30 }); await recordEvent(id, "restart", `${name} was restarted.`, "success"); }
  });
  invalidateServerList();
  return { message: `${name} ${action === "stop" ? "stopped" : `${action}ed`}.` };
}

export async function listBackups(id: string): Promise<BackupRecord[]> {
  if (isDemo()) return demoState().backups[id] || [];
  const cached = backupLists.get(id);
  if (cached && Date.now() - cached.at < 5000) return cached.promise;
  const promise = readBackups(id);
  backupLists.set(id, { at: Date.now(), promise });
  promise.catch(() => { if (backupLists.get(id)?.promise === promise) backupLists.delete(id); });
  return promise;
}

async function readBackups(id: string): Promise<BackupRecord[]> {
  return (await listIncrementalSnapshots(id)).map(incrementalBackupRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Retention is applied per kind, so safety snapshots and manual backups never evict scheduled history. */
async function applyRetention(id: string, retention: number) {
  const snapshots = await listBackups(id);
  await forgetIncrementalSnapshots(id, snapshotsToForget(snapshots, retention).map((backup) => backup.name));
  forgetBackupList(id);
}

async function createBackupUnlocked(id: string, providedInfo: ContainerInfo | undefined, options: { kind?: string; prune?: boolean; allowStop?: boolean } = {}) {
  const info = providedInfo || await findInfo(id);
  const container = docker.getContainer(info.Id);
  const wasRunning = info.State === "running";
  const kind = (options.kind || "manual").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  let backupName = "";
  let savesDisabled = false;
  let stoppedForConsistency = false;
  let failure: unknown;
  try {
    if (wasRunning) {
      try {
        setOperationStep(id, "Saving the world");
        await sendMinecraftCommand(container, "save-off");
        savesDisabled = true;
        await sendMinecraftCommand(container, "save-all flush");
        await new Promise((resolve) => setTimeout(resolve, 800));
      } catch (error) {
        // Unattended backups never take a running server offline; they fail and alert instead.
        if (options.allowStop === false) throw new Error(`RCON is unavailable, so the backup was skipped rather than stopping the server. ${describe(error, "")}`.trim());
        await recordEvent(id, "backup", `RCON save was unavailable; the server was stopped briefly to create a consistent backup. ${describe(error, "")}`.trim(), "warning");
        await container.stop({ t: 30 });
        stoppedForConsistency = true;
      }
    }
    setOperationStep(id, "Creating the backup");
    backupName = await createIncrementalSnapshot(id, kind);
  } catch (error) {
    failure = error;
  }
  const cleanup: string[] = [];
  if (stoppedForConsistency) {
    try { await container.start(); await waitUntilReady(container); }
    catch (error) { cleanup.push(`The server could not be restarted after the backup: ${describe(error, "unknown error")}`); }
  } else if (savesDisabled) {
    await sendMinecraftCommand(container, "save-on").catch((error) => cleanup.push(`World saving could not be re-enabled (run "save-on" from the console): ${describe(error, "unknown error")}`));
  }
  if (failure || cleanup.length) {
    const message = [failure ? describe(failure, "Backup failed.") : "The backup completed.", ...cleanup].join(" ");
    throw new Error(message);
  }
  await markBackupRun(id);
  forgetBackupList(id);
  if (options.prune !== false) await applyRetention(id, (await getServerControl(id)).backupPolicy.retention);
  await recordEvent(id, "backup", `${backupKindLabel(kind)} backup completed.`, "success");
  return { message: `${backupKindLabel(kind)} backup created.`, backup: backupName };
}

async function demoBackup(id: string, kind = "manual") {
  const server = demoServer(id);
  server.backupCount += 1;
  demoState().backups[id] ??= [];
  demoState().backups[id].unshift({ name: `snapshot-${randomBytes(32).toString("hex")}`, size: Math.round(server.diskUsageBytes / 40), logicalSize: server.diskUsageBytes, createdAt: new Date().toISOString(), kind });
  await markBackupRun(id);
  await recordEvent(id, "backup", `${backupKindLabel(kind)} backup completed.`, "success");
}

async function clearServerData(meta: ServerMeta) {
  const root = serverDataPath(meta.id);
  const entries = await readdir(root).catch(() => [] as string[]);
  try { await Promise.all(entries.map((entry) => rm(path.join(root, entry), { recursive: true, force: true }))); }
  catch (error) { throw new Error(`Could not clear the current data: ${describe(error, "unknown error")}`); }
}

async function restoreStoredBackup(meta: ServerMeta, name: string) {
  await getIncrementalSnapshot(meta.id, name);
  await clearServerData(meta);
  await restoreIncrementalSnapshot(meta.id, name);
  diskUsage.delete(meta.id);
}

export async function restoreBackup(id: string, name: string) {
  if (isDemo()) {
    demoServer(id);
    return demoOperation(id, "restore", "Restoring a backup", ["Taking a safety backup", "Stopping the server", "Restoring world files", "Waiting for Minecraft to start"], async () => {
      await recordEvent(id, "restore", "Backup restored and health check passed.", "success");
    });
  }
  await getIncrementalSnapshot(id, name);
  return restoreServerFiles(id, "Restoring a backup", () => restoreIncrementalSnapshot(id, name), "Backup restored and health check passed.");
}

/**
 * Replaces a server's files: takes a safety backup, stops the server, empties its data folder, runs
 * `restore` to fill it, and starts it again. If anything fails, the safety backup is put back.
 */
export async function restoreServerFiles(id: string, label: string, restore: () => Promise<void>, success: string) {
  const info = await findInfo(id);
  return startServerOperation(id, "restore", label, async () => {
    const container = docker.getContainer(info.Id);
    const meta = metaFromLabels(info.Labels);
    setOperationStep(id, "Taking a safety backup");
    const safety = await createBackupUnlocked(id, info, { kind: "pre-restore", prune: false });
    setOperationStep(id, "Stopping the server");
    await stopContainer(container);
    try {
      setOperationStep(id, "Restoring world files");
      await clearServerData(meta);
      await restore();
      diskUsage.delete(id);
      await container.start();
      setOperationStep(id, "Waiting for Minecraft to start");
      await waitUntilReady(container);
      await applyRetention(id, (await getServerControl(id)).backupPolicy.retention);
      await recordEvent(id, "restore", success, "success");
    } catch (error) {
      const failure = describe(error, "Restore failed.");
      setOperationStep(id, "Restore failed; reapplying the safety backup");
      try {
        try { const state = await container.inspect(); if (state.State.Running) await container.stop({ t: 10 }); } catch { /* stopped */ }
        await restoreStoredBackup(meta, safety.backup);
        await container.start();
        await waitUntilReady(container);
      } catch (rollbackError) {
        throw new Error(`${failure} Reapplying the pre-restore backup also failed: ${describe(rollbackError, "unknown error")}. The server needs manual attention; ${safety.backup} is intact.`);
      }
      throw new Error(`${failure} The pre-restore backup was reapplied.`);
    } finally {
      invalidateServerList();
    }
  });
}

/** A server's settings as stored with its offsite copies (its server.json, without host paths). */
export async function serverSettingsForOffsite(id: string) {
  const settings: Partial<ServerMeta> = metaFromLabels((await findInfo(id)).Labels);
  delete settings.dataPath;
  return settings;
}

/**
 * Recreates a server from an offsite copy, keeping its ID: validates its settings like a new
 * server's, lets `restore` fill its data folder (and local backups), then creates and starts its
 * container. Refuses when the ID or port is already in use on this panel.
 */
export async function adoptRestoredServer(id: string, stored: Record<string, unknown>, restore: () => Promise<void>) {
  assertServerId(id);
  if (isDemo()) throw new BadRequestError("Restoring requires a real Docker host.");
  const parsed = updateServerSchema.safeParse(stored);
  if (!parsed.success) throw new Error(`Its saved settings aren't valid: ${parsed.error.issues[0]?.message || "unknown problem"}`);
  if ((await managedContainers()).some((item) => item.Labels?.["panel.id"] === id) || pendingCreations.has(id)) throw new ConflictError("It's already on this panel.");
  if (await lstat(serverRootPath(id)).catch(() => undefined) || await lstat(serverBackupPath(id)).catch(() => undefined)) throw new ConflictError("Its files are already on this panel, as a detached world. Reattach or delete it first.");
  await assertPortAvailable(parsed.data.port);
  const createdAt = typeof stored.createdAt === "string" && !Number.isNaN(Date.parse(stored.createdAt)) ? stored.createdAt : new Date().toISOString();
  const meta: ServerMeta = { ...parsed.data, id, createdAt, dataPath: dockerServerDataPath(id) };
  const data = serverDataPath(id);
  await mkdir(data, { recursive: true });
  await chown(data, 1000, 1000).catch(() => undefined);
  await chmod(data, 0o770).catch(() => undefined);
  try { await restore(); }
  catch (error) {
    await rm(serverRootPath(id), { recursive: true, force: true }).catch(() => undefined);
    await rm(serverBackupPath(id), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await recordEvent(id, "restore", `${meta.name} was restored from an offsite backup.`, "success");
  return launchNewServer(meta);
}

export async function deleteBackup(id: string, name: string) {
  if (isDemo()) {
    const state = demoState();
    state.backups[id] = (state.backups[id] || []).filter((backup) => backup.name !== name);
    const server = state.servers.find((candidate) => candidate.id === id);
    if (server) server.backupCount = state.backups[id].length;
    await recordEvent(id, "backup-delete", `Backup ${name} was deleted.`, "warning");
    return;
  }
  await withServerLock(id, "backup-delete", "Deleting a backup", async () => {
    await forgetIncrementalSnapshots(id, [name]);
  });
  forgetBackupList(id);
  await recordEvent(id, "backup-delete", `Backup ${name} was deleted.`, "warning");
}

/** Follows container output. The containers use a TTY, so the stream is raw text rather than multiplexed. */
export async function streamLogs(id: string, signal: AbortSignal): Promise<Readable> {
  if (isDemo()) {
    demoServer(id);
    const logs = demoState().logs;
    let sent = 0;
    const stream = new Readable({ read() {} });
    const push = () => { const lines = logs[id] || []; if (lines.length > sent) { stream.push(`${lines.slice(sent).join("\n")}\n`); sent = lines.length; } };
    push();
    const timer = setInterval(push, 1000);
    signal.addEventListener("abort", () => { clearInterval(timer); stream.push(null); }, { once: true });
    return stream;
  }
  const info = await findInfo(id);
  const stream = await docker.getContainer(info.Id).logs({ follow: true, stdout: true, stderr: true, tail: 350, timestamps: false }) as unknown as Readable;
  signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return stream;
}

/** Sends a console command over RCON and returns the server's reply (e.g. the player list for `list`). */
export async function sendConsoleCommand(id: string, rawCommand: string) {
  const command = rawCommand.trim().replace(/^\/+/, "");
  if (!command) throw new BadRequestError("Enter a command.");
  assertRconCommand(command);
  if (isDemo()) {
    const server = demoServer(id);
    if (server.status !== "running") throw new BadRequestError("Start the server before sending a command.");
    const state = demoState();
    if (command.startsWith("say ")) { state.logs[id] ??= []; state.logs[id].push(`[Server thread/INFO]: [Server] ${command.slice(4)}`); }
    if (command === "list") return `There are ${server.players.length} of a max of ${server.maxPlayers} players online: ${server.players.join(", ")}`;
    return command.startsWith("say ") ? "" : "Command executed.";
  }
  const info = await findInfo(id);
  if (info.State !== "running") throw new BadRequestError("Start the server before sending a command.");
  return sendMinecraftCommand(docker.getContainer(info.Id), command);
}

export async function removeServer(id: string, options: { purge?: boolean } = {}) {
  if (isDemo()) {
    const state = demoState(); const index = state.servers.findIndex((server) => server.id === id);
    if (index === -1) throw new NotFoundError("Server not found.");
    const [server] = state.servers.splice(index, 1); delete state.logs[id];
    await recordEvent(id, "remove", `${server.name} container was removed${options.purge ? " with its data" : "; data was retained"}.`, "warning");
    return;
  }
  const info = await findInfo(id);
  await withServerLock(id, "remove", "Removing the server", async () => {
    const container = docker.getContainer(info.Id);
    await stopContainer(container).catch(() => undefined);
    await container.remove({ force: true });
    if (options.purge) await purgeServerFiles(id);
    else await recordEvent(id, "remove", `${info.Labels["panel.name"]} container was removed; data was retained.`, "warning");
  });
  invalidateServerList();
}

async function purgeServerFiles(id: string) {
  await rm(serverRootPath(id), { recursive: true, force: true });
  await rm(serverBackupPath(id), { recursive: true, force: true });
  await removeServerControl(id);
  diskUsage.delete(id);
  forgetBackupList(id);
  metaWritten.delete(id);
}

/** World directories and backup repositories left behind by removed servers. */
export async function listDetachedWorlds(): Promise<DetachedWorld[]> {
  if (isDemo()) return [];
  const attached = new Set((await managedContainers()).map((item) => item.Labels?.["panel.id"]));
  for (const id of pendingCreations.keys()) attached.add(id);
  const names = async (directory: string) => (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && isServerId(entry.name)).map((entry) => entry.name);
  const withData = new Set(await names(storagePath(STORAGE_ROOT, "servers")));
  const withBackups = new Set(await names(storagePath(STORAGE_ROOT, "backups")));
  const ids = [...new Set([...withData, ...withBackups])].filter((id) => !attached.has(id));
  return Promise.all(ids.map(async (id) => {
    const config = await readServerMeta(id);
    return { id, name: config?.name || `Server ${id.slice(0, 8)}`, diskUsageBytes: withData.has(id) ? worldSize(id) : 0, hasData: withData.has(id), hasBackups: withBackups.has(id), canReattach: Boolean(config) && withData.has(id), config };
  }));
}

export async function reattachServer(id: string) {
  if (isDemo()) throw new BadRequestError("Reattaching requires a real Docker host.");
  assertServerId(id);
  if ((await managedContainers()).some((item) => item.Labels?.["panel.id"] === id)) throw new ConflictError("This server already has a container.");
  const meta = await readServerMeta(id);
  if (!meta) throw new NotFoundError("No saved configuration exists for this world, so it cannot be reattached automatically.");
  await assertPortAvailable(meta.port, id);
  const pending = pendingSummary(meta, "Queued");
  pendingCreations.set(id, pending);
  invalidateServerList();
  return startServerOperation(id, "create", `Reattaching ${meta.name}`, async () => {
    try {
      await provisionContainer(meta, pending);
      await recordEvent(id, "create", `${meta.name} was reattached to a new container.`, "success");
    } finally {
      pendingCreations.delete(id);
      invalidateServerList();
    }
  });
}

export async function deleteDetachedWorld(id: string) {
  if (isDemo()) throw new BadRequestError("Deleting worlds requires a real Docker host.");
  assertServerId(id);
  if ((await managedContainers()).some((item) => item.Labels?.["panel.id"] === id) || pendingCreations.has(id)) throw new ConflictError("Remove the server's container before deleting its data.");
  await withServerLock(id, "remove", "Deleting world data", () => purgeServerFiles(id));
}

function maintenanceDue(control: Awaited<ReturnType<typeof getServerControl>>, now = Date.now()) {
  const age = (value?: string) => value ? now - new Date(value).getTime() : Infinity;
  return { prune: age(control.maintenance?.lastPruneAt) > DAY_MS, check: age(control.maintenance?.lastCheckAt) > 7 * DAY_MS };
}

async function runMaintenance(id: string) {
  const control = await getServerControl(id);
  const now = Date.now();
  if (maintenanceDue(control, now).prune) {
    // Mark the attempt either way so a failing prune retries tomorrow, not every minute.
    await markMaintenance(id, { lastPruneAt: new Date().toISOString() });
    await pruneIncrementalRepository(id).catch((error) => recordEvent(id, "backup-prune", `Pruning unused backup data failed: ${describe(error, "unknown error")}`, "warning"));
  }
  if (maintenanceDue(control, now).check) {
    try {
      await checkIncrementalRepository(id);
      await markMaintenance(id, { lastCheckAt: new Date().toISOString() });
    } catch (error) {
      await markMaintenance(id, { lastCheckAt: new Date().toISOString() });
      await recordEvent(id, "backup-check", `Backup repository integrity check failed: ${describe(error, "unknown error")}`, "error");
    }
  }
}

export async function runScheduledBackups() {
  if (isDemo()) return;
  for (const info of await managedContainers()) {
    const id = info.Labels?.["panel.id"];
    if (!id || !isServerId(id) || activeOperation(id)) continue;
    const control = await getServerControl(id);
    const policy = control.backupPolicy;
    try {
      if (scheduledBackupDue(policy, control.schedule)) {
        await withServerLock(id, "scheduled-backup", "Scheduled backup", async () => {
          // The list above can be minutes old when earlier servers had long backups, so check the
          // container's current state; a server that is still starting is tried again next minute.
          const current = await timed(docker.getContainer(info.Id).inspect(), "a container inspect");
          if (waitingForStartup(current.State)) return;
          try {
            await createBackupUnlocked(id, undefined, { kind: "scheduled", allowStop: false });
            await markScheduledAttempt(id, true);
          } catch (error) {
            const failures = await markScheduledAttempt(id, false);
            await recordEvent(id, "backup", `Scheduled backup failed (${failures} in a row): ${describe(error, "Unknown error")}`, shouldAlertFailure(failures) ? "error" : "warning");
            return;
          }
        });
      }
      const due = maintenanceDue(await getServerControl(id));
      if ((due.prune || due.check) && !activeOperation(id)) await withServerLock(id, "scheduled-backup", "Backup maintenance", () => runMaintenance(id));
    } catch (error) {
      console.error(`Blocky scheduled work for ${id} failed`, error);
    }
  }
}
