import "server-only";

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentActor } from "@/lib/actor";
import { notify } from "@/lib/notify";
import { PANEL_ROOT } from "@/lib/paths";

export type BackupPolicy = {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  lastRunAt?: string;
};

type OperationEvent = {
  id: string;
  at: string;
  type: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  actor?: string;
};

export type ScheduleState = {
  lastAttemptAt?: string;
  consecutiveFailures: number;
};

type MaintenanceState = {
  lastPruneAt?: string;
  lastCheckAt?: string;
};

type ServerControl = {
  backupPolicy: BackupPolicy;
  events: OperationEvent[];
  schedule?: ScheduleState;
  maintenance?: MaintenanceState;
  observedStatus?: string;
  observedRestartCount?: number;
};

type ControlState = {
  version: 1;
  servers: Record<string, ServerControl>;
};

const statePath = path.join(/* turbopackIgnore: true */ PANEL_ROOT, "control-state.json");
const backupStatePath = `${statePath}.bak`;
const defaultPolicy: BackupPolicy = { enabled: true, intervalHours: 6, retention: 14 };
const MAX_EVENTS = 100;
let queue: Promise<unknown> = Promise.resolve();

function freshState(): ControlState {
  return { version: 1, servers: {} };
}

async function parseStateFile(file: string) {
  const parsed = JSON.parse(await readFile(file, "utf8")) as ControlState;
  if (!parsed || typeof parsed !== "object" || typeof parsed.servers !== "object") throw new SyntaxError("Control state has an unexpected shape.");
  return parsed;
}

async function readState(): Promise<ControlState> {
  try {
    return await parseStateFile(statePath);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    try {
      const recovered = await parseStateFile(backupStatePath);
      if (!missing) console.error("Blocky control state was unreadable; recovered from the previous copy.", error);
      return recovered;
    } catch {
      if (missing) return freshState();
      // Never silently overwrite an unreadable state file: move it aside so it can be inspected.
      const preserved = `${statePath}.corrupt-${Date.now()}`;
      await rename(statePath, preserved).catch(() => undefined);
      console.error(`Blocky control state was unreadable and no valid backup exists. The damaged file was preserved at ${preserved}.`, error);
      return freshState();
    }
  }
}

async function writeState(state: ControlState) {
  await mkdir(PANEL_ROOT, { recursive: true });
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  await copyFile(statePath, backupStatePath).catch(() => undefined);
  await rename(temporary, statePath);
}

function ensureServer(state: ControlState, id: string) {
  state.servers[id] ??= { backupPolicy: { ...defaultPolicy }, events: [] };
  return state.servers[id];
}

function pushEvent(server: ServerControl, event: OperationEvent) {
  server.events.unshift(event);
  server.events = server.events.slice(0, MAX_EVENTS);
  if (event.level === "error") void notify(event.message);
}

/** Consistent sentence casing and punctuation for the activity log. */
function normalizeMessage(message: string) {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;
  const sentence = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function newEvent(type: string, message: string, level: OperationEvent["level"], actor?: string): OperationEvent {
  return { id: randomUUID(), at: new Date().toISOString(), type, level, message: normalizeMessage(message), ...(actor ? { actor } : {}) };
}

async function mutate<T>(callback: (state: ControlState) => T | Promise<T>): Promise<T> {
  const work = queue.then(async () => {
    const state = await readState();
    const before = JSON.stringify(state);
    const result = await callback(state);
    // Status polling calls this constantly; only touch the disk when something changed.
    if (JSON.stringify(state) !== before) await writeState(state);
    return result;
  });
  queue = work.catch(() => undefined);
  return work;
}

export async function getServerControl(id: string): Promise<ServerControl> {
  await queue;
  const state = await readState();
  const value = state.servers[id] ?? { backupPolicy: { ...defaultPolicy }, events: [] };
  return structuredClone(value);
}

export async function setBackupPolicy(id: string, policy: Omit<BackupPolicy, "lastRunAt">) {
  return mutate((state) => {
    const server = ensureServer(state, id);
    server.backupPolicy = { ...server.backupPolicy, ...policy };
    // A new schedule is a fresh start; don't keep backing off from old failures.
    server.schedule = { ...server.schedule, consecutiveFailures: 0 };
    return structuredClone(server.backupPolicy);
  });
}

export async function markBackupRun(id: string, at = new Date().toISOString()) {
  return mutate((state) => {
    const server = ensureServer(state, id);
    server.backupPolicy.lastRunAt = at;
  });
}

export async function markScheduledAttempt(id: string, succeeded: boolean, at = new Date().toISOString()) {
  return mutate((state) => {
    const server = ensureServer(state, id);
    const failures = server.schedule?.consecutiveFailures ?? 0;
    server.schedule = { lastAttemptAt: at, consecutiveFailures: succeeded ? 0 : failures + 1 };
    return server.schedule.consecutiveFailures;
  });
}

export async function markMaintenance(id: string, values: Partial<MaintenanceState>) {
  return mutate((state) => {
    const server = ensureServer(state, id);
    server.maintenance = { ...server.maintenance, ...values };
  });
}

export async function recordEvent(id: string, type: string, message: string, level: OperationEvent["level"] = "info") {
  const actor = await currentActor();
  return mutate((state) => {
    const event = newEvent(type, message, level, actor);
    pushEvent(ensureServer(state, id), event);
    return event;
  });
}

export async function recordObservedStatus(id: string, status: string, serverName: string, restartCount = 0) {
  return mutate((state) => {
    const server = ensureServer(state, id);
    if (server.observedStatus && server.observedStatus !== status) {
      pushEvent(server, newEvent("status", `${serverName} changed from ${server.observedStatus} to ${status}.`, status === "failed" ? "error" : "info"));
    }
    if (server.observedRestartCount !== undefined && restartCount > server.observedRestartCount) {
      pushEvent(server, newEvent("restart", `${serverName} restarted automatically (${restartCount} total).`, "warning"));
    }
    server.observedStatus = status;
    server.observedRestartCount = restartCount;
  });
}

export async function removeServerControl(id: string) {
  return mutate((state) => { delete state.servers[id]; });
}
