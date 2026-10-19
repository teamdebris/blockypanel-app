import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const data = await mkdtemp(path.join(os.tmpdir(), "blocky-world-")); process.env.BLOCKY_DATA = data;
const root = fileURLToPath(new URL("../", import.meta.url));
const bundled = await build({ stdin: { contents: ['world', 'store', 'control', 'files', 'backups'].map((name) => `export * from './src/server/${name}';`).join('\n'), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
after(async () => { await rm(data, { recursive: true, force: true }); });
let port = 33000;
const server = () => core.addServer({ ...core.GAME_DEFAULTS, name: "Test world", software: "vanilla", version: "1.21.8", memoryMb: 1024, port: port++, motd: "Test", maxPlayers: 10, difficulty: "normal", icon: "grass" });
function tar(items) {
  const blocks = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? ""); const header = Buffer.alloc(512);
    header.write(item.name, 0, 100, "utf8"); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136); header.write("0", 156); header.write("ustar\u000000", 257); header.fill(0x20, 148, 156);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

test("world imports replace all dimensions, normalize Bukkit layout, and preserve a safety copy", async () => {
  const instance = await server();
  for (const dir of ["world", "world_nether", "world_the_end"]) { await core.makeDirectory(instance.id, dir); await core.writeText(instance.id, `${dir}/old.txt`, "old world"); }
  const archive = tar([{ name: "Server/world/level.dat", data: "LEVEL" }, { name: "Server/world/region/r.0.0.mca", data: "OVERWORLD" }, { name: "Server/world_nether/DIM-1/region/r.0.0.mca", data: "NETHER" }, { name: "Server/world_the_end/DIM1/region/r.0.0.mca", data: "END" }]);
  await core.importWorld(instance, "world.tar", Readable.from([archive]));
  const folder = path.join(data, "servers", instance.id);
  assert.equal(await readFile(path.join(folder, "world/region/r.0.0.mca"), "utf8"), "OVERWORLD");
  assert.equal(await readFile(path.join(folder, "world/DIM-1/region/r.0.0.mca"), "utf8"), "NETHER");
  assert.equal(await readFile(path.join(folder, "world/DIM1/region/r.0.0.mca"), "utf8"), "END");
  assert.ok(!(await readdir(folder)).includes("world_nether"));
  assert.equal((await core.listBackups(instance.id)).filter((backup) => backup.kind === "safety").length, 1);
  assert.deepEqual(await readdir(path.join(folder, ".blocky-uploads")), []);
});

test("hostile Windows archive names and ambiguous dimensions leave the original world intact", async () => {
  const instance = await server(); await core.makeDirectory(instance.id, "world"); await core.writeText(instance.id, "world/original.txt", "keep me");
  const cases = [
    [{ name: "level.dat", data: "LEVEL" }, { name: "CON.txt", data: "bad" }],
    [{ name: "level.dat", data: "LEVEL" }, { name: "level.dat:stream", data: "bad" }],
    [{ name: "level.dat", data: "LEVEL" }, { name: "Config.txt", data: "one" }, { name: "config.txt", data: "two" }],
    [{ name: "world/level.dat", data: "LEVEL" }, { name: "world/DIM-1/r.mca", data: "one" }, { name: "world_nether/DIM-1/r.mca", data: "two" }],
    [{ name: "../outside.txt", data: "bad" }],
  ];
  for (const files of cases) {
    await assert.rejects(core.importWorld(instance, "bad.tar", Readable.from([tar(files)])));
    assert.equal((await core.readText(instance.id, "world/original.txt")).content, "keep me");
  }
  assert.deepEqual(await readdir(path.join(data, "staging")), []);
});

test("world reset validates seeds, respects custom level-name, and saves all old dimensions", async () => {
  const instance = await server(); await core.writeText(instance.id, "server.properties", "level-name=Survival\n");
  for (const name of ["Survival", "Survival_nether", "Survival_the_end"]) { await core.makeDirectory(instance.id, name); await core.writeText(instance.id, `${name}/old.txt`, "keep in backup"); }
  await assert.rejects(core.resetWorld(instance, "bad\nport=1"), /without control characters/);
  await core.resetWorld(instance, "new seed");
  assert.equal((await core.getServer(instance.id)).seed, "new seed");
  assert.deepEqual((await core.worldInfo(instance)).folders, []);
  const backups = await core.listBackups(instance.id); assert.equal(backups.length, 1);
  const held = path.join(data, "backups", instance.id, backups[0].name);
  assert.equal(await readFile(path.join(held, "Survival_nether/old.txt"), "utf8"), "keep in backup");
});
