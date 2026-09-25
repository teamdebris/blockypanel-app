import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSchedule, MISSED_GRACE_MS, nextOccurrence, type ScheduledTask, taskAction, warningMinutes, zonedTime } from "../lib/tasks.ts";

const iso = (value: number) => new Date(value).toISOString();

test("wall-clock times convert to instants, including across daylight saving", () => {
  assert.equal(iso(zonedTime(2026, 1, 15, 4, 0, "Europe/London")), "2026-01-15T04:00:00.000Z");
  assert.equal(iso(zonedTime(2026, 7, 15, 4, 0, "Europe/London")), "2026-07-15T03:00:00.000Z");
  assert.equal(iso(zonedTime(2026, 7, 15, 4, 0, "America/New_York")), "2026-07-15T08:00:00.000Z");
  // 02:30 doesn't exist in New York on 8 March 2026; it resolves to just after the jump.
  assert.equal(iso(zonedTime(2026, 3, 8, 2, 30, "America/New_York")), "2026-03-08T07:30:00.000Z");
  // 01:30 happens twice in New York on 1 November 2026; the first one is used.
  assert.equal(iso(zonedTime(2026, 11, 1, 1, 30, "America/New_York")), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(zonedTime(2026, 5, 1, 12, 0, "UTC")), "2026-05-01T12:00:00.000Z");
});

test("daily schedules find the next matching day and time", () => {
  const daily = { type: "daily" as const, time: "04:00", days: [], timeZone: "UTC" };
  assert.equal(iso(nextOccurrence(daily, Date.parse("2026-09-25T03:59:00Z"))), "2026-09-25T04:00:00.000Z");
  assert.equal(iso(nextOccurrence(daily, Date.parse("2026-09-25T04:00:00Z"))), "2026-09-26T04:00:00.000Z");
  // 2026-09-25 is a Friday; Mondays only.
  assert.equal(iso(nextOccurrence({ ...daily, days: [1] }, Date.parse("2026-09-25T12:00:00Z"))), "2026-09-28T04:00:00.000Z");
  assert.equal(iso(nextOccurrence({ type: "interval", hours: 6 }, Date.parse("2026-09-25T00:00:00Z"))), "2026-09-25T06:00:00.000Z");
});

test("tasks run on time, restarts start early to warn, and missed daily runs are skipped", () => {
  const task: ScheduledTask = { id: "t", kind: "restart", warnMinutes: 5, enabled: true, createdAt: "2026-09-25T00:00:00Z", schedule: { type: "daily", time: "04:00", days: [], timeZone: "UTC" } };
  const at = Date.parse("2026-09-25T04:00:00Z");
  assert.deepEqual(taskAction(task, at - 6 * 60_000), { action: "wait" });
  assert.deepEqual(taskAction(task, at - 5 * 60_000), { action: "run", at });
  assert.deepEqual(taskAction({ ...task, kind: "command", command: "save-all" }, at - 60_000), { action: "wait" });
  assert.deepEqual(taskAction(task, at + MISSED_GRACE_MS + 1), { action: "skip", at });
  assert.deepEqual(taskAction({ ...task, lastRunAt: iso(at) }, at + 60_000), { action: "wait" });
  assert.deepEqual(taskAction({ ...task, enabled: false }, at), { action: "wait" });
  // Interval tasks catch up instead of skipping.
  const interval: ScheduledTask = { ...task, kind: "broadcast", message: "hi", schedule: { type: "interval", hours: 2 } };
  assert.equal(taskAction(interval, Date.parse("2026-09-25T09:00:00Z")).action, "run");
});

test("schedules read naturally, and restart warnings count down", () => {
  assert.equal(describeSchedule({ type: "daily", time: "04:00", days: [], timeZone: "UTC" }), "Every day at 04:00");
  assert.equal(describeSchedule({ type: "daily", time: "18:30", days: [5, 1, 3], timeZone: "UTC" }), "Mon, Wed, Fri at 18:30");
  assert.equal(describeSchedule({ type: "daily", time: "09:00", days: [1, 2, 3, 4, 5], timeZone: "UTC" }), "Weekdays at 09:00");
  assert.equal(describeSchedule({ type: "interval", hours: 1 }), "Every hour");
  assert.deepEqual(warningMinutes(5), [5, 3, 2, 1]);
  assert.deepEqual(warningMinutes(0), []);
  assert.deepEqual(warningMinutes(12), [10, 5, 3, 2, 1]);
});
