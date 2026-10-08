import assert from "node:assert/strict";
import { test } from "node:test";
import { serverHealth, serverStatus, startupSetupError } from "../lib/server-status.ts";

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

const run = (error: string) => [
  "[init] Running as uid=1000 gid=1000 with /data as 'drwxrwx--- 9 1000 1000 4096 Oct  6 19:43 /data'",
  "[init] Resolving type given FABRIC",
  "\x1b[39m[mc-image-helper] 03:19:30.127 INFO  : Fabric launcher for minecraft 26.3 loader 0.19.5 is already available",
  error,
].join("\n");
const missingMod = "\x1b[0;39m\x1b[1;31m[mc-image-helper] 03:19:32.218 ERROR : Invalid parameter provided for 'modrinth' command: No files are available for the project 'Vanilla One Block' for loader fabric and Minecraft version 26.3";

test("a Modrinth project with no file for the version is a setup error that repeats", () => {
  assert.deepEqual(startupSetupError(`${run(missingMod)}\n${run(missingMod)}\n\x1b[0;39m`), {
    command: "modrinth",
    message: "No files are available for the project 'Vanilla One Block' for loader fabric and Minecraft version 26.3",
  });
});

test("only the last run's error counts, and other failures don't stop the server", () => {
  assert.equal(startupSetupError(`${run(missingMod)}\n${run("[mc-image-helper] 03:20:01.000 ERROR : Failed to download: Connection reset")}`), undefined);
  assert.equal(startupSetupError(run("[Server thread/ERROR]: Encountered an unexpected exception")), undefined);
  assert.equal(startupSetupError(""), undefined);
});
