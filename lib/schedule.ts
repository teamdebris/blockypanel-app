import type { BackupPolicy, ScheduleState } from "@/lib/store";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Delay before retrying after `failures` consecutive scheduled-backup failures: 15m, 30m, 1h, ... capped at the interval. */
export function retryDelayMs(failures: number, intervalHours: number) {
  if (failures <= 0) return 0;
  return Math.min(15 * MINUTE * 2 ** (failures - 1), intervalHours * HOUR);
}

export function scheduledBackupDue(policy: BackupPolicy, schedule: ScheduleState | undefined, now = Date.now()) {
  if (!policy.enabled) return false;
  const lastRun = policy.lastRunAt ? new Date(policy.lastRunAt).getTime() : 0;
  if (now - lastRun < policy.intervalHours * HOUR) return false;
  const failures = schedule?.consecutiveFailures ?? 0;
  if (!failures || !schedule?.lastAttemptAt) return true;
  return now - new Date(schedule.lastAttemptAt).getTime() >= retryDelayMs(failures, policy.intervalHours);
}

/** When the scheduler will next attempt a backup (ISO string), or undefined when disabled. Checks run once a minute. */
export function nextScheduledBackupAt(policy: BackupPolicy, schedule: ScheduleState | undefined, now = Date.now()) {
  if (!policy.enabled) return undefined;
  const lastRun = policy.lastRunAt ? new Date(policy.lastRunAt).getTime() : 0;
  let next = lastRun + policy.intervalHours * HOUR;
  const failures = schedule?.consecutiveFailures ?? 0;
  if (failures && schedule?.lastAttemptAt) next = Math.max(next, new Date(schedule.lastAttemptAt).getTime() + retryDelayMs(failures, policy.intervalHours));
  return new Date(Math.max(next, now)).toISOString();
}

/**
 * A container Docker has just (re)started, after a crash or a host reboot, is "running" before the
 * game finishes starting, and Minecraft only answers RCON once it's up. A scheduled backup then
 * waits for the next check instead of failing.
 */
export function waitingForStartup(state: { Running: boolean; Health?: { Status: string } }) {
  return state.Running && state.Health?.Status === "starting";
}

/** Alert on the first failure, then only when the streak hits 3, 10, 25, ... to avoid flooding the webhook. */
export function shouldAlertFailure(failures: number) {
  return failures === 1 || failures === 3 || failures === 10 || (failures > 10 && failures % 25 === 0);
}
