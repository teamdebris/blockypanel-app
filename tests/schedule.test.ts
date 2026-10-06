import assert from "node:assert/strict";
import { test } from "node:test";
import { retryDelayMs, scheduledBackupDue, shouldAlertFailure, waitingForStartup } from "../lib/schedule.ts";

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 8, 22, 12);
const policy = { enabled: true, intervalHours: 6, retention: 14 };
const ago = (ms: number) => new Date(now - ms).toISOString();

test("a never-run schedule is due", () => {
  assert.equal(scheduledBackupDue(policy, undefined, now), true);
});

test("disabled schedules are never due", () => {
  assert.equal(scheduledBackupDue({ ...policy, enabled: false }, undefined, now), false);
});

test("waits for the interval after a successful run", () => {
  assert.equal(scheduledBackupDue({ ...policy, lastRunAt: ago(5 * HOUR) }, { consecutiveFailures: 0 }, now), false);
  assert.equal(scheduledBackupDue({ ...policy, lastRunAt: ago(6 * HOUR) }, { consecutiveFailures: 0 }, now), true);
});

test("backs off after failures instead of retrying every minute", () => {
  const failing = { ...policy, lastRunAt: ago(24 * HOUR) };
  assert.equal(scheduledBackupDue(failing, { consecutiveFailures: 1, lastAttemptAt: ago(60_000) }, now), false);
  assert.equal(scheduledBackupDue(failing, { consecutiveFailures: 1, lastAttemptAt: ago(15 * 60_000) }, now), true);
  assert.equal(scheduledBackupDue(failing, { consecutiveFailures: 3, lastAttemptAt: ago(30 * 60_000) }, now), false);
  assert.equal(scheduledBackupDue(failing, { consecutiveFailures: 3, lastAttemptAt: ago(HOUR) }, now), true);
});

test("retry delay is capped at the backup interval", () => {
  assert.equal(retryDelayMs(0, 6), 0);
  assert.equal(retryDelayMs(1, 6), 15 * 60_000);
  assert.equal(retryDelayMs(20, 6), 6 * HOUR);
});

test("alerts sparingly during a failure streak", () => {
  const alerted = Array.from({ length: 60 }, (_, index) => index + 1).filter(shouldAlertFailure);
  assert.deepEqual(alerted, [1, 3, 10, 25, 50]);
});

test("scheduled backups wait while a server is still starting", () => {
  // Docker restarted it (crash, host reboot): running, but Minecraft isn't answering RCON yet.
  assert.equal(waitingForStartup({ Running: true, Health: { Status: "starting" } }), true);
  assert.equal(waitingForStartup({ Running: true, Health: { Status: "healthy" } }), false);
  // Unhealthy servers still get attempted, so a stuck server alerts instead of silently skipping.
  assert.equal(waitingForStartup({ Running: true, Health: { Status: "unhealthy" } }), false);
  // Stopped servers are backed up from disk; images without a health check aren't held back.
  assert.equal(waitingForStartup({ Running: false, Health: { Status: "starting" } }), false);
  assert.equal(waitingForStartup({ Running: true }), false);
});
