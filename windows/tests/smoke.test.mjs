import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("Windows distribution serves its embedded UI and isolates local state", { timeout: 30000 }, async () => {
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
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await page.text(), /app\.js/);
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
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(data, { recursive: true, force: true });
  }
});
