import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ScheduledTask } from "../../../lib/tasks";
import { DATA_ROOT } from "./paths";
import { JsonStore } from "./json-store";

export type Activity = { id: string; at: string; level: "info" | "success" | "error"; message: string };
export type BackupPolicy = { enabled: boolean; intervalHours: number; retention: number; mode?: "copy" | "incremental"; lastRunAt?: string };
export type InstalledAddon = { projectId: string; versionId: string; title: string; version: string; file: string; sha512?: string; sha1?: string; requested: boolean; optionalDependencies: boolean; dependencies: string[]; installedAt: string };
export type ServerControl = {
  backupPolicy: BackupPolicy; tasks: ScheduledTask[]; events: Activity[];
  backupSchedule?: { lastAttemptAt?: string; consecutiveFailures: number; lastError?: string };
  addons?: InstalledAddon[];
};
type State = { version: 1; servers: Record<string, ServerControl> };
const valid = (value: unknown): value is State => {
  const state = value as State;
  return state?.version === 1 && !!state.servers && typeof state.servers === "object" && !Array.isArray(state.servers)
    && Object.values(state.servers).every((s) => !!s.backupPolicy && Array.isArray(s.tasks) && Array.isArray(s.events));
};
const store = new JsonStore<State>(path.join(DATA_ROOT, "control-state.json"), () => ({ version: 1, servers: {} }), valid);
const fresh = (): ServerControl => ({ backupPolicy: { enabled: false, intervalHours: 6, retention: 14 }, tasks: [], events: [] });
export const getControl = async (id: string) => (await store.read()).servers[id] ?? fresh();
export const changeControl = <T>(id: string, work: (control: ServerControl) => T | Promise<T>) => store.change(async (state) => { state.servers[id] ??= fresh(); return work(state.servers[id]); });
export const removeControl = (id: string) => store.change((state) => { delete state.servers[id]; });
export const recordEvent = (id: string, message: string, level: Activity["level"] = "info") => changeControl(id, (state) => {
  state.events.unshift({ id: randomUUID(), at: new Date().toISOString(), level, message });
  state.events = state.events.slice(0, 200);
});
