import { randomUUID } from "node:crypto";
import { isTimeZone, MAX_TASKS, nextRun, type ScheduledTask, type TaskSchedule } from "../../../lib/tasks";
import { changeControl, getControl, recordEvent } from "./control";
import { HttpError } from "./errors";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid task.");
  return value as Record<string, unknown>;
}
const singleLine = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
export function parseTask(value: unknown): Pick<ScheduledTask, "kind" | "schedule" | "command" | "message" | "warnMinutes" | "enabled"> {
  const input = object(value);
  if (!["restart", "command", "broadcast"].includes(String(input.kind))) throw new HttpError(400, "Choose a restart, command, or chat message.");
  const kind = input.kind as ScheduledTask["kind"];
  const source = object(input.schedule);
  let schedule: TaskSchedule;
  if (source.type === "interval") {
    if (!Number.isInteger(source.hours) || Number(source.hours) < 1 || Number(source.hours) > 168) throw new HttpError(400, "Intervals must be 1 to 168 hours.");
    schedule = { type: "interval", hours: Number(source.hours) };
  } else if (source.type === "daily") {
    if (typeof source.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(source.time)) throw new HttpError(400, "Choose a time in HH:MM format.");
    if (typeof source.timeZone !== "string" || source.timeZone.length > 64 || !isTimeZone(source.timeZone)) throw new HttpError(400, "Choose a valid time zone.");
    if (!Array.isArray(source.days) || source.days.length > 7 || source.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new HttpError(400, "Choose valid weekdays.");
    schedule = { type: "daily", time: source.time, timeZone: source.timeZone, days: [...new Set(source.days as number[])].sort() };
  } else throw new HttpError(400, "Choose a daily time or an interval.");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new HttpError(400, "Invalid enabled value.");
  const warnMinutes = input.warnMinutes ?? 5;
  if (!Number.isInteger(warnMinutes) || Number(warnMinutes) < 0 || Number(warnMinutes) > 30) throw new HttpError(400, "Restart warnings must be 0 to 30 minutes.");
  const out: ReturnType<typeof parseTask> = { kind, schedule, enabled: input.enabled !== false, warnMinutes: Number(warnMinutes) };
  if (kind === "command") {
    if (!singleLine(input.command, 512)) throw new HttpError(400, "Enter a console command of at most 512 characters on one line.");
    out.command = (input.command as string).trim().replace(/^\/+/, "");
    if (!out.command || out.command.startsWith("-")) throw new HttpError(400, "Enter a valid console command.");
  }
  if (kind === "broadcast") {
    if (!singleLine(input.message, 200)) throw new HttpError(400, "Enter a chat message of at most 200 characters on one line.");
    out.message = (input.message as string).trim();
  }
  return out;
}

export async function listTasks(id: string) {
  return (await getControl(id)).tasks.map((task) => ({ ...task, nextRunAt: task.enabled ? new Date(nextRun(task)).toISOString() : undefined }));
}
export async function saveTask(id: string, input: unknown, taskId?: string) {
  const data = parseTask(input);
  const saved = await changeControl(id, (state) => {
    const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
    if (taskId && !task) throw new HttpError(404, "That task doesn't exist.");
    if (!task && state.tasks.length >= MAX_TASKS) throw new HttpError(400, `Keep at most ${MAX_TASKS} tasks per server.`);
    if (task) {
      Object.assign(task, data, { createdAt: new Date().toISOString(), lastRunAt: undefined, lastResult: undefined });
      return task;
    }
    const created: ScheduledTask = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    state.tasks.push(created);
    return created;
  });
  await recordEvent(id, `Scheduled ${saved.kind} task ${taskId ? "updated" : "created"}.`);
  return saved;
}
export async function deleteTask(id: string, taskId: string) {
  await changeControl(id, (state) => {
    if (!state.tasks.some((task) => task.id === taskId)) throw new HttpError(404, "That task doesn't exist.");
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
  });
  await recordEvent(id, "Scheduled task deleted.");
}
