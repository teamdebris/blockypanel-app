import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlayerList } from "../lib/players.ts";
import { nextScheduledBackupAt } from "../lib/schedule.ts";

test("parses the modern list format", () => {
  assert.deepEqual(parsePlayerList("There are 2 of a max of 20 players online: Steve, Alex_99"), { online: 2, names: ["Steve", "Alex_99"] });
});

test("parses the legacy list format and an empty server", () => {
  assert.deepEqual(parsePlayerList("There are 1/20 players online:\nNotch"), { online: 1, names: ["Notch"] });
  assert.deepEqual(parsePlayerList("There are 0 of a max of 20 players online: "), { online: 0, names: [] });
});

test("drops color codes and anything that isn't a valid username", () => {
  assert.deepEqual(parsePlayerList("There are 2 of a max of 20 players online: §aSteve, <script>").names, ["Steve"]);
});

test("next scheduled backup accounts for the interval and failure backoff", () => {
  const now = Date.UTC(2026, 8, 22, 12);
  const hour = 3_600_000;
  const policy = { enabled: true, intervalHours: 6, retention: 14, lastRunAt: new Date(now - 2 * hour).toISOString() };
  assert.equal(nextScheduledBackupAt(policy, undefined, now), new Date(now + 4 * hour).toISOString());
  assert.equal(nextScheduledBackupAt({ ...policy, enabled: false }, undefined, now), undefined);
  const overdue = { ...policy, lastRunAt: new Date(now - 24 * hour).toISOString() };
  assert.equal(nextScheduledBackupAt(overdue, { consecutiveFailures: 1, lastAttemptAt: new Date(now - 5 * 60_000).toISOString() }, now), new Date(now + 10 * 60_000).toISOString());
});
