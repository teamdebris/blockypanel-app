import assert from "node:assert/strict";
import { test } from "node:test";
import { retentionGroup, SAFETY_SNAPSHOTS_KEPT, snapshotsToForget } from "../lib/retention.ts";

function snapshots(kind: string, count: number, startHour = 0) {
  return Array.from({ length: count }, (_, index) => ({ name: `${kind}-${index}`, kind, createdAt: new Date(Date.UTC(2026, 0, 1, startHour + index)).toISOString() }));
}

test("groups kinds into scheduled, manual, and safety", () => {
  assert.equal(retentionGroup("scheduled"), "scheduled");
  assert.equal(retentionGroup("manual"), "manual");
  assert.equal(retentionGroup("pre-update"), "safety");
  assert.equal(retentionGroup("pre-restore"), "safety");
});

test("safety snapshots never evict scheduled history", () => {
  const all = [...snapshots("scheduled", 3), ...snapshots("pre-settings", 20, 10)];
  const forgotten = snapshotsToForget(all, 3);
  assert.equal(forgotten.filter((item) => item.kind === "scheduled").length, 0);
  assert.equal(forgotten.length, 20 - SAFETY_SNAPSHOTS_KEPT);
});

test("keeps the newest entries of each group", () => {
  const forgotten = snapshotsToForget(snapshots("scheduled", 5), 2);
  assert.deepEqual(forgotten.map((item) => item.name).sort(), ["scheduled-0", "scheduled-1", "scheduled-2"]);
});

test("manual backups are retained separately from scheduled ones", () => {
  const forgotten = snapshotsToForget([...snapshots("manual", 2), ...snapshots("scheduled", 4, 5)], 2);
  assert.deepEqual(forgotten.map((item) => item.name).sort(), ["scheduled-0", "scheduled-1"]);
});
