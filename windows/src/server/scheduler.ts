import { taskAction, warningMinutes } from "../../../lib/tasks";
import { createBackup, deleteBackup, listBackups } from "./backups";
import { changeControl, getControl, recordEvent } from "./control";
import { activeOperation, withServerLock } from "./operations";
import { isActive, restart, runtimeInfo, sendCommand } from "./minecraft";
import { getServer, loadServers } from "./store";
import { copyOffsiteAfterBackup } from "./offsite";

const HOUR = 3600000;
const warnings = new Map<string, { at: number; revision: string; sent: Set<number> }>();
let ticking = false;
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

export async function tickScheduler(now = Date.now()) {
  if (ticking || stopped) return;
  ticking = true;
  try {
    for (const server of await loadServers()) {
      if (stopped) break;
      if (activeOperation(server.id)) continue;
      const control = await getControl(server.id);
      const status = runtimeInfo(server.id).status;
      const policy = control.backupPolicy;
      const retry = control.backupSchedule;
      const backoff = Math.min(15 * 60000 * 2 ** Math.max(0, (retry?.consecutiveFailures ?? 0) - 1), policy.intervalHours * HOUR);
      if (policy.enabled && (status === "running" || !isActive(server.id)) && now >= Date.parse(policy.lastRunAt || "1970-01-01") + policy.intervalHours * HOUR
        && (!retry?.consecutiveFailures || now >= Date.parse(retry.lastAttemptAt || "1970-01-01") + backoff)) {
        try {
          await withServerLock(server.id, "scheduled backup", async () => {
            await changeControl(server.id, (state) => { state.backupSchedule = { ...state.backupSchedule, consecutiveFailures: state.backupSchedule?.consecutiveFailures ?? 0, lastAttemptAt: new Date(now).toISOString() }; });
            await createBackup(server.id, "scheduled");
            await changeControl(server.id, (state) => { state.backupPolicy.lastRunAt = new Date(now).toISOString(); state.backupSchedule = { lastAttemptAt: new Date(now).toISOString(), consecutiveFailures: 0 }; });
            const scheduled = (await listBackups(server.id)).filter((backup) => backup.kind === "scheduled");
            for (const old of scheduled.slice(policy.retention)) await deleteBackup(server.id, old.name);
            await recordEvent(server.id, "Scheduled backup completed.", "success");
            await copyOffsiteAfterBackup(server.id);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Backup failed.";
          await changeControl(server.id, (state) => { state.backupSchedule = { lastAttemptAt: new Date(now).toISOString(), consecutiveFailures: (state.backupSchedule?.consecutiveFailures ?? 0) + 1, lastError: message }; });
          await recordEvent(server.id, `Scheduled backup failed: ${message}`, "error");
        }
      }
      const tasks = (await getControl(server.id)).tasks;
      const currentKeys = new Set(tasks.map((task) => `${server.id}/${task.id}`));
      for (const key of warnings.keys()) if (key.startsWith(`${server.id}/`) && !currentKeys.has(key)) warnings.delete(key);
      for (const task of tasks) {
        if (stopped) break;
        const decision = taskAction(task, now);
        const key = `${server.id}/${task.id}`;
        if (decision.action === "wait") { warnings.delete(key); continue; }
        let outcome: { ok: boolean; message: string } | undefined;
        if (decision.action === "skip") outcome = { ok: false, message: "Skipped a daily task missed while the panel was closed." };
        else if (runtimeInfo(server.id).status !== "running") {
          if (task.kind === "restart" && now < decision.at) continue;
          outcome = { ok: false, message: "Skipped because the server was not running." };
        }
        else if (task.kind === "restart" && now < decision.at) {
          let warning = warnings.get(key);
          if (!warning || warning.at !== decision.at || warning.revision !== task.createdAt) { warning = { at: decision.at, revision: task.createdAt, sent: new Set() }; warnings.set(key, warning); }
          const due = warningMinutes(task.warnMinutes ?? 0).filter((minutes) => now >= decision.at - minutes * 60000 && !warning!.sent.has(minutes));
          for (const minutes of due) warning.sent.add(minutes);
          if (due.length && runtimeInfo(server.id).players.length) {
            const minutes = Math.min(...due);
            sendCommand(server.id, `say Server restarting in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
          }
          continue;
        } else {
          if (activeOperation(server.id)) continue;
          try {
            await withServerLock(server.id, `scheduled ${task.kind}`, async () => {
              // The server may have been deleted or changed since this tick started.
              const latest = await getServer(server.id);
              if (!latest) return;
              if (task.kind === "restart") await restart(latest);
              else sendCommand(server.id, task.kind === "broadcast" ? `say ${task.message}` : task.command!);
            });
            outcome = { ok: true, message: `Scheduled ${task.kind} completed.` };
          } catch (error) { outcome = { ok: false, message: error instanceof Error ? error.message : "Task failed." }; }
        }
        warnings.delete(key);
        if (outcome) {
          const result = outcome;
          await changeControl(server.id, (state) => {
            const current = state.tasks.find((item) => item.id === task.id);
            if (current && current.createdAt === task.createdAt) { current.lastRunAt = new Date(decision.at).toISOString(); current.lastResult = { ...result, at: new Date(now).toISOString() }; }
          });
          await recordEvent(server.id, outcome.message, outcome.ok ? "success" : "error");
        }
      }
    }
  } finally { ticking = false; }
}
export function startScheduler() {
  if (timer) return;
  stopped = false;
  const tick = () => { void tickScheduler().catch((error) => console.error("Scheduled work failed:", error)); };
  timer = setInterval(tick, 10000);
  timer.unref();
  tick();
}
export function stopScheduler() { stopped = true; if (timer) clearInterval(timer); timer = undefined; warnings.clear(); }
