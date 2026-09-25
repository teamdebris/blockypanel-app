/**
 * Scheduled tasks: restarts, console commands, and broadcasts, daily at a time or every few hours.
 * Pure (no Next.js or Docker), so the timing rules are unit-tested. Daily times are wall-clock times
 * in the task's time zone, so "04:00" stays 04:00 across daylight-saving changes.
 */

export type TaskKind = "restart" | "command" | "broadcast";
export type TaskSchedule =
  | { type: "daily"; time: string; days: number[]; timeZone: string }
  | { type: "interval"; hours: number };

export type TaskResult = { at: string; ok: boolean; message: string };

export type ScheduledTask = {
  id: string;
  kind: TaskKind;
  schedule: TaskSchedule;
  /** For "command": the console command, without a leading slash. */
  command?: string;
  /** For "broadcast": the chat message. */
  message?: string;
  /** For "restart": minutes of warnings in chat beforehand (only when someone is online). */
  warnMinutes?: number;
  enabled: boolean;
  createdAt: string;
  /** The scheduled time of the last run (or skip), which the next one counts from. */
  lastRunAt?: string;
  lastResult?: TaskResult;
};

export const MAX_TASKS = 20;
const HOUR = 60 * 60 * 1000;
/** A daily run the panel missed (it was down) by more than this is skipped, not run late. */
export const MISSED_GRACE_MS = 30 * 60 * 1000;
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function isTimeZone(value: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock date and time at `instant` in `timeZone`. */
function zonedParts(instant: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number]) };
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function offsetAt(instant: number, timeZone: string) {
  const parts = zonedParts(instant, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `timeZone`. A time skipped by a daylight-saving jump
 * resolves to the moment after the jump; a repeated one to its first occurrence.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  const matches = [first, second].filter((instant) => { const parts = zonedParts(instant, timeZone); return parts.hour === hour && parts.minute === minute; });
  // Both match in the repeated hour (take the first); neither in the skipped hour (take the one after the jump).
  return matches.length ? Math.min(...matches) : Math.max(first, second);
}

/** The first scheduled time strictly after `after`. */
export function nextOccurrence(schedule: TaskSchedule, after: number) {
  if (schedule.type === "interval") return after + schedule.hours * HOUR;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const today = zonedParts(after, schedule.timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = date.getUTCDay();
    if (schedule.days.length && !schedule.days.includes(weekday)) continue;
    const candidate = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, schedule.timeZone);
    if (candidate > after) return candidate;
  }
  throw new Error("No upcoming time for this schedule.");
}

/** How long before its scheduled time a task starts: restarts start early to warn players. */
export function leadTime(task: Pick<ScheduledTask, "kind" | "warnMinutes">) {
  return task.kind === "restart" ? Math.max(0, task.warnMinutes ?? 0) * 60_000 : 0;
}

/** When the task next runs (its scheduled time), counted from its last run or its creation. */
export function nextRun(task: ScheduledTask) {
  return nextOccurrence(task.schedule, Date.parse(task.lastRunAt || task.createdAt));
}

/**
 * What the scheduler should do with a task now: nothing, run it (for the scheduled time `at`), or
 * skip a daily run that was missed by more than the grace period (the panel was down).
 */
export function taskAction(task: ScheduledTask, now: number): { action: "wait" } | { action: "run" | "skip"; at: number } {
  if (!task.enabled) return { action: "wait" };
  const at = nextRun(task);
  if (now < at - leadTime(task)) return { action: "wait" };
  if (task.schedule.type === "daily" && now > at + MISSED_GRACE_MS) return { action: "skip", at };
  return { action: "run", at };
}

/** "Every day at 04:00", "Mon, Wed, Fri at 18:30", "Every 6 hours". */
export function describeSchedule(schedule: TaskSchedule) {
  if (schedule.type === "interval") return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  const days = schedule.days.length === 0 || schedule.days.length === 7 ? "Every day"
    : schedule.days.length === 5 && [1, 2, 3, 4, 5].every((day) => schedule.days.includes(day)) ? "Weekdays"
      : schedule.days.length === 2 && schedule.days.includes(0) && schedule.days.includes(6) ? "Weekends"
        : [...schedule.days].sort().map((day) => WEEKDAYS[day]).join(", ");
  return `${days} at ${schedule.time}`;
}

/** The chat warnings before a restart: minutes left at which to announce it, largest first. */
export function warningMinutes(warn: number) {
  return [30, 15, 10, 5, 3, 2, 1].filter((minutes) => minutes <= warn).filter((minutes, index, list) => index === 0 || minutes < list[0]);
}
