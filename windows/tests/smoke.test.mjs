import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("Windows distribution serves its embedded UI and isolates local state", { timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const release = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const data = await mkdtemp(path.join(os.tmpdir(), "blocky-windows-test-"));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const executable = process.env.BLOCKY_TEST_EXE;
  const child = spawn(executable || process.execPath, executable ? [] : [path.join(root, "dist/server.cjs")], {
    cwd: root,
    env: { ...process.env, BLOCKY_DATA: data, BLOCKY_PORT: String(port), BLOCKY_NO_BROWSER: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${url}/api/state`)).ok; } catch { /* starting */ }
      if (ready || child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, `Application did not become ready: ${output}`);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.version, release.version);
    assert.equal(state.dataRoot, data);
    assert.deepEqual(state.servers, []);
    await t.test("a second instance reuses this data folder's existing panel", async () => {
      const second = spawn(executable || process.execPath, executable ? [] : [path.join(root, "dist/server.cjs")], { cwd: root, env: { ...process.env, BLOCKY_DATA: data, BLOCKY_PORT: String(port), BLOCKY_NO_BROWSER: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let message = ""; second.stdout.on("data", (chunk) => { message += chunk; });
      const code = await new Promise((resolve) => second.once("exit", resolve));
      assert.equal(code, 0); assert.match(message, /already running/);
      assert.equal(JSON.parse(await readFile(path.join(data, "panel.lock"), "utf8")).pid, child.pid);
    });
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await page.text(), /app\.js\?build=/);
    for (const asset of ["app.js", "app.css", "theme.js", "favicon.svg", "brand/blocky-panel-mark-light.svg", "blocks/grass.svg"]) {
      assert.equal((await fetch(`${url}/${asset}`)).status, 200, asset);
    }
    const denied = await fetch(`${url}/api/servers`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 403);
    const invalid = await fetch(`${url}/api/servers`, { method: "POST", headers: { "x-blocky-request": "1" }, body: "{}" });
    assert.equal(invalid.status, 400);
    const created = await fetch(`${url}/api/servers`, {
      method: "POST", headers: { "x-blocky-request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Smoke Test", eula: true, software: "vanilla", version: "1.21.8", memoryMb: 1024, port: 25565 }),
    });
    assert.equal(created.status, 201);
    const server = await created.json();
    assert.equal(server.status, "stopped");
    const persisted = JSON.parse(await readFile(path.join(data, "servers.json"), "utf8"));
    assert.equal(persisted.servers[0].id, server.id);
    const request = (route, method, body) => fetch(`${url}/api/servers/${server.id}/${route}`, {
      method, headers: { "x-blocky-request": "1", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await t.test("file API edits, uploads, downloads and rejects Windows path escapes", async () => {
      assert.equal((await request("files", "POST", { path: "plugins" })).status, 200);
      assert.equal((await request("files", "PUT", { path: "plugins/config.yml", content: "enabled: true\n" })).status, 200);
      const original = await (await request("files?path=plugins%2Fconfig.yml&text=1", "GET")).json();
      assert.equal(original.content, "enabled: true\n");
      assert.match(original.revision, /^[a-f0-9]{64}$/);
      assert.equal((await request("files", "PUT", { path: "plugins/config.yml", content: "overwrite" })).status, 409);
      assert.equal((await request("files", "PUT", { path: "plugins/config.yml", content: "enabled: false\n", revision: original.revision })).status, 200);
      assert.equal((await request("files", "PUT", { path: "plugins/config.yml", content: "stale", revision: original.revision })).status, 409);
      for (const name of ["../outside.txt", "C:\\secret.txt", "CON.txt", "config.yml:stream"]) {
        assert.equal((await request(`files?text=1&path=${encodeURIComponent(name)}`, "GET")).status, 400, name);
      }
      const binary = Buffer.from([0, 1, 2, 3, 255]);
      const uploaded = await fetch(`${url}/api/servers/${server.id}/upload?path=plugins%2Fexample.jar`, { method: "POST", headers: { "x-blocky-request": "1" }, body: binary });
      assert.equal(uploaded.status, 201);
      const downloaded = await request("download?path=plugins%2Fexample.jar", "GET");
      assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), binary);
      assert.equal((await request("files", "PATCH", { path: "plugins/example.jar", destination: "plugins/renamed.jar" })).status, 200);
      assert.equal((await request("files?path=plugins%2Frenamed.jar", "DELETE")).status, 200);
    });
    await t.test("task and backup policy APIs validate input and persist schedules", async () => {
      const task = { kind: "broadcast", message: "Hello players", schedule: { type: "daily", time: "04:00", timeZone: "America/Chicago", days: [1, 3, 5] } };
      const createdTask = await request("tasks", "POST", task); assert.equal(createdTask.status, 201);
      const saved = await createdTask.json();
      const listed = await (await request("tasks", "GET")).json();
      assert.equal(listed.tasks[0].id, saved.id); assert.ok(listed.tasks[0].nextRunAt);
      assert.equal((await request(`tasks/${saved.id}`, "PUT", { ...task, enabled: false })).status, 200);
      assert.equal((await request("tasks", "POST", { ...task, message: "bad\ncommand" })).status, 400);
      assert.equal((await request("backup-policy", "PUT", { enabled: false, intervalHours: 2, retention: 5 })).status, 200);
      assert.equal((await (await request("backup-policy", "GET")).json()).policy.retention, 5);
      assert.equal((await request("backup-policy", "PUT", { enabled: true, intervalHours: 0, retention: 5 })).status, 400);
      assert.equal((await request(`tasks/${saved.id}`, "DELETE")).status, 200);
    });
    await t.test("backup API restores a previous file and records activity", async () => {
      const backup = await request("backups", "POST"); assert.equal(backup.status, 201);
      const { name } = await backup.json();
      const current = await (await request("files?text=1&path=plugins%2Fconfig.yml", "GET")).json();
      assert.equal((await request("files", "PUT", { path: "plugins/config.yml", content: "changed after backup", revision: current.revision })).status, 200);
      assert.equal((await request(`backups/${name}/restore`, "POST")).status, 200);
      assert.equal((await (await request("files?text=1&path=plugins%2Fconfig.yml", "GET")).json()).content, "enabled: false\n");
      const events = await (await request("events", "GET")).json();
      assert.ok(events.events.some((event) => event.message.includes("Backup restored")));
      assert.ok((await (await request("backups", "GET")).json()).backups.some((backup) => backup.kind === "safety"));
    });
    await t.test("gameplay settings and cross-origin request protection", async () => {
      const settings = await fetch(`${url}/api/servers/${server.id}`, { method: "PATCH", headers: { "x-blocky-request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ gameMode: "creative", pvp: false, viewDistance: 8, seed: "a new seed" }) });
      assert.equal(settings.status, 200); assert.equal((await settings.json()).gameMode, "creative");
      const rejected = await fetch(`${url}/api/servers/${server.id}`, { method: "PATCH", headers: { "x-blocky-request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ seed: "seed\nserver-port=1234" }) });
      assert.equal(rejected.status, 400);
      assert.equal((await fetch(`${url}/api/state`, { headers: { Origin: "https://example.org" } })).status, 403);
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(data, { recursive: true, force: true });
  }
});
