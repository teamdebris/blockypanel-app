import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, utimes } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const data = await mkdtemp(path.join(os.tmpdir(), "blocky-features-"));
process.env.BLOCKY_DATA = data;
const root = fileURLToPath(new URL("../", import.meta.url));
const bundled = await build({
  stdin: { contents: ['json-store', 'store', 'control', 'tasks', 'scheduler', 'files', 'backups', 'operations'].map((name) => `export * from './src/server/${name}';`).join('\n'), resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false,
});
const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
after(async () => { await rm(data, { recursive: true, force: true }); });
let port = 31000;
const makeServer = async () => core.addServer({ ...core.GAME_DEFAULTS, name: "Test server", software: "vanilla", version: "1.21.8", memoryMb: 1024, port: port++, motd: "Test", maxPlayers: 10, difficulty: "normal", icon: "grass" });

test("JSON state serializes concurrent writes and recovers after a rejected edit", async () => {
  const file = path.join(data, "atomic.json");
  const store = new core.JsonStore(file, () => ({ count: 0 }), (value) => typeof value?.count === "number");
  await Promise.all(Array.from({ length: 20 }, () => store.change((state) => { state.count++; })));
  assert.equal((await store.read()).count, 20);
  await assert.rejects(store.change((state) => { state.count = 100; throw new Error("cancel"); }), /cancel/);
  await store.change((state) => { state.count++; });
  assert.equal(JSON.parse(await readFile(file, "utf8")).count, 21);
  const external = await store.read(); external.count = 900;
  assert.equal((await store.read()).count, 21);
});

test("corrupt state is preserved and a valid backup survives another restart", async () => {
  const file = path.join(data, "recovery.json");
  await writeFile(file, "damaged"); await writeFile(`${file}.bak`, '{"count":7}');
  const create = () => new core.JsonStore(file, () => ({ count: 0 }), (value) => typeof value?.count === "number");
  assert.equal((await create().read()).count, 7);
  assert.ok((await readdir(data)).some((name) => name.startsWith("recovery.json.corrupt-")));
  assert.equal((await create().read()).count, 7);
  const bad = path.join(data, "unrecoverable.json"); await writeFile(bad, "do not overwrite");
  await assert.rejects(new core.JsonStore(bad, () => ({}), () => true).change(() => {}), /not been overwritten/);
  assert.equal(await readFile(bad, "utf8"), "do not overwrite");
});

test("native file manager confines paths, rejects junctions and detects stale edits", async () => {
  const server = await makeServer();
  await core.makeDirectory(server.id, "plugins");
  await core.writeText(server.id, "plugins/config.yml", "enabled: true\n");
  const original = await core.readText(server.id, "plugins/config.yml");
  assert.equal(original.content, "enabled: true\n");
  await utimes(path.join(data, "servers", server.id, "plugins/config.yml"), new Date(0), new Date(0));
  await assert.rejects(core.writeText(server.id, "plugins/config.yml", "stale", original.modifiedAt), /changed since/);
  for (const invalid of ["../secret.txt", "plugins/../../secret.txt", "C:/secret.txt", "/secret.txt", "file.txt:stream", "CON.txt", "nul", "folder./x", "name ", "a//b", "a/./b", "bad\0.txt"]) {
    await assert.rejects(core.readText(server.id, invalid), (error) => error.status === 400, invalid);
  }
  const outside = path.join(data, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret.txt"), "private");
  const junction = path.join(data, "servers", server.id, "outside"); await symlink(outside, junction, "junction");
  await assert.rejects(core.readText(server.id, "outside/secret.txt"), /Links and junctions/);
  assert.ok(!(await core.listFiles(server.id, "")).some((entry) => entry.name === "outside"));
  await rm(junction);
  const upload = Readable.from([Buffer.from([0, 1, 2]), Buffer.from([3, 4])]);
  await core.uploadFile(server.id, "plugins/test.jar", upload);
  assert.deepEqual(await readFile(path.join(data, "servers", server.id, "plugins/test.jar")), Buffer.from([0, 1, 2, 3, 4]));
  await assert.rejects(core.uploadFile(server.id, "plugins/test.jar", Readable.from(["overwrite"])), /already exists/);
  await core.renameFile(server.id, "plugins/config.yml", "plugins/renamed.yml");
  await core.deleteFile(server.id, "plugins/renamed.yml");
  await assert.rejects(core.deleteFile(server.id, ""), /root cannot be deleted/);
});

test("backups have unique names, restore safely, and retention preserves manual and safety copies", async () => {
  const server = await makeServer();
  await core.makeDirectory(server.id, "world");
  await core.writeText(server.id, "world/level.txt", "original world");
  const manual = await core.createBackup(server.id);
  const second = await core.createBackup(server.id);
  assert.notEqual(manual, second);
  await core.writeText(server.id, "world/level.txt", "changed world", undefined, (await core.readText(server.id, "world/level.txt")).revision);
  await core.restoreBackup(server.id, manual);
  assert.equal((await core.readText(server.id, "world/level.txt")).content, "original world");
  assert.ok((await core.listBackups(server.id)).some((backup) => backup.kind === "safety"));
  await core.changeControl(server.id, (state) => { state.backupPolicy = { enabled: true, intervalHours: 1, retention: 1 }; });
  const now = Date.now(); await core.tickScheduler(now); await core.tickScheduler(now + 3600001);
  const backups = await core.listBackups(server.id);
  assert.equal(backups.filter((backup) => backup.kind === "scheduled").length, 1);
  assert.equal(backups.filter((backup) => backup.kind === "manual").length, 2);
  assert.equal(backups.filter((backup) => backup.kind === "safety").length, 1);
  await core.changeControl(server.id, (state) => { state.backupPolicy.enabled = false; });
});

test("task validation, time-zone scheduling and stopped-server skips share Linux timing rules", async () => {
  const server = await makeServer();
  const valid = { kind: "command", command: "say hello", enabled: true, schedule: { type: "daily", time: "04:00", timeZone: "America/Chicago", days: [1, 1, 3] } };
  assert.deepEqual(core.parseTask(valid).schedule.days, [1, 3]);
  for (const change of [{ command: "say hello\nstop" }, { schedule: { type: "interval", hours: 0 } }, { schedule: { type: "daily", time: "25:30", timeZone: "UTC", days: [] } }, { schedule: { type: "daily", time: "04:00", timeZone: "unknown/timezone", days: [] } }]) assert.throws(() => core.parseTask({ ...valid, ...change }));
  const task = await core.saveTask(server.id, { kind: "broadcast", message: "Scheduled message", schedule: { type: "interval", hours: 1 } });
  const now = Date.now();
  await core.changeControl(server.id, (state) => { state.tasks[0].createdAt = new Date(now - 3600001).toISOString(); });
  await core.tickScheduler(now);
  const stored = (await core.getControl(server.id)).tasks[0];
  assert.equal(stored.lastResult.ok, false); assert.match(stored.lastResult.message, /not running/);
  assert.ok(Date.parse((await core.listTasks(server.id))[0].nextRunAt) > now);
  await core.deleteTask(server.id, task.id); assert.equal((await core.listTasks(server.id)).length, 0);
});

test("server operation locks reject concurrent changes and always release after failure", async () => {
  let finish;
  const first = core.withServerLock("lock-test", "backup", () => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(core.withServerLock("lock-test", "restore", async () => {}), (error) => error.status === 409);
  finish(); await first;
  await assert.rejects(core.withServerLock("lock-test", "failing", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(core.activeOperation("lock-test"), undefined);
});
