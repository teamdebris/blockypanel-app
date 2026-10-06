import assert from "node:assert/strict";
import { test } from "node:test";
import { serverHealth, serverStatus } from "../lib/server-status.ts";

const started = "2026-10-03T10:00:00Z";

test("a server the panel stopped shows as stopped, whatever code Docker left", () => {
  assert.equal(serverStatus({ state: "exited", exitCode: 137, startedAt: started, panelStoppedAt: "2026-10-03T12:00:00Z" }), "stopped");
  assert.equal(serverStatus({ state: "exited", exitCode: 1, startedAt: started, panelStoppedAt: "2026-10-03T12:00:00Z" }), "stopped");
});

test("clean exits and stop requests are stopped, crashes are failed", () => {
  assert.equal(serverStatus({ state: "exited", exitCode: 0 }), "stopped");
  assert.equal(serverStatus({ state: "exited", exitCode: 143 }), "stopped", "SIGTERM: docker stop or a host shutdown");
  assert.equal(serverStatus({ state: "exited", exitCode: 1, startedAt: started }), "failed");
  assert.equal(serverStatus({ state: "exited", exitCode: 137, startedAt: started }), "failed", "killed without the panel stopping it");
  assert.equal(serverStatus({ state: "exited", exitCode: 137, oomKilled: true, startedAt: started, panelStoppedAt: "2026-10-03T12:00:00Z" }), "failed", "out of memory is always a failure");
});

test("a stop from before the last start doesn't excuse a later crash", () => {
  assert.equal(serverStatus({ state: "exited", exitCode: 1, startedAt: "2026-10-03T13:00:00Z", panelStoppedAt: "2026-10-03T12:00:00Z" }), "failed");
});

test("health only counts while running", () => {
  assert.equal(serverHealth({ state: "exited", health: "unhealthy" }), "stopped");
  assert.equal(serverHealth({ state: "running", health: "unhealthy" }), "unhealthy");
  assert.equal(serverHealth({ state: "running" }), "running");
  assert.equal(serverStatus({ state: "running", health: "unhealthy" }), "failed");
  assert.equal(serverStatus({ state: "running", health: "starting" }), "starting");
  assert.equal(serverStatus({ state: "created" }), "starting");
});
