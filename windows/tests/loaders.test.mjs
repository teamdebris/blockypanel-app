import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const data = await mkdtemp(path.join(os.tmpdir(), "blocky-loaders-")); process.env.BLOCKY_DATA = data;
const root = fileURLToPath(new URL("../", import.meta.url));
const originalFetch = globalThis.fetch;
const installer = Buffer.from("official installer fixture");
const hash = (algorithm) => createHash(algorithm).update(installer).digest("hex");
const json = (value) => new Response(JSON.stringify(value));
const spawned = [];
globalThis.__blockyTestSpawn = (java, args, options) => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit("exit", 1);
  spawned.push({ java, args, options });
  void (async () => {
    const relative = args[1].includes("quilt") ? "quilt-server-launch.jar" : args[1].includes("neoforge") ? "libraries/net/neoforged/neoforge/21.8.47/win_args.txt" : "libraries/net/minecraftforge/forge/1.21.8-58.1.0/win_args.txt";
    const full = path.join(options.cwd, relative); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, "launcher fixture"); child.stdout.write("Installation complete\n"); child.emit("exit", 0);
  })().catch((error) => child.emit("error", error));
  return child;
};
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.pathname.endsWith("promotions_slim.json")) return json({ promos: { "1.21.8-recommended": "58.1.0", "1.21.8-latest": "58.1.4" } });
  if (url.pathname.endsWith("/versions/releases/net/neoforged/neoforge")) return json({ versions: ["21.8.47", "21.8.99-beta", "26.3.0.94", "26.1.2.55"] });
  if (url.hostname === "meta.quiltmc.org" && url.pathname.endsWith("/installer")) return json([{ version: "0.15.1", url: "https://maven.quiltmc.org/installer.jar", hashes: { sha256: hash("sha256") } }]);
  if (url.hostname === "meta.quiltmc.org" && url.pathname.includes("/loader/")) return json([{ loader: { version: "0.31.0-beta.1" } }, { loader: { version: "0.30.0" } }]);
  if (url.pathname.endsWith(".sha1")) return new Response(hash("sha1"));
  if (url.pathname.endsWith(".sha256")) return new Response(hash("sha256"));
  if (url.pathname.endsWith(".jar")) return new Response(installer);
  throw new Error(`Unexpected request: ${url}`);
};
const bundled = await build({ stdin: { contents: "export * from './src/server/loaders';", resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "fake-java", setup(build) { build.onResolve({ filter: /^node:child_process$/ }, () => ({ path: "fake-java", namespace: "test" })); build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const spawn = (...args) => globalThis.__blockyTestSpawn(...args);" })); } }],
});
const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
after(async () => { globalThis.fetch = originalFetch; delete globalThis.__blockyTestSpawn; await rm(data, { recursive: true, force: true }); });

test("NeoForge version mapping handles legacy and calendar Minecraft versions", () => {
  assert.equal(core.neoMinecraftVersion("21.8.47"), "1.21.8");
  assert.equal(core.neoMinecraftVersion("26.3.0.94"), "26.3");
  assert.equal(core.neoMinecraftVersion("26.1.2.55"), "26.1.2");
  assert.equal(core.neoMinecraftVersion("21.8.99-beta"), undefined);
});

test("native Forge, NeoForge and Quilt installers produce reusable Windows launch commands", async () => {
  const expected = {
    forge: ["@libraries/net/minecraftforge/forge/1.21.8-58.1.0/win_args.txt", "nogui"],
    neoforge: ["@libraries/net/neoforged/neoforge/21.8.47/win_args.txt", "nogui"],
    quilt: ["-jar", "quilt-server-launch.jar", "nogui"],
  };
  let count = 0;
  for (const software of ["forge", "neoforge", "quilt"]) {
    const id = `00000000000${++count}`;
    const directory = path.join(data, "servers", id); await mkdir(directory, { recursive: true });
    const args = await core.prepareLoader(software, "1.21.8", id, "java.exe", () => {}, () => {});
    assert.deepEqual(args, expected[software]);
    const command = spawned.at(-1); assert.equal(command.options.windowsHide, true); assert.equal(command.args[0], "-jar");
    if (software === "quilt") { assert.ok(command.args.includes("--install-dir=.")); assert.ok(command.args.includes("0.30.0")); }
    const before = spawned.length;
    assert.deepEqual(await core.prepareLoader(software, "1.21.8", id, "java.exe", () => {}, () => {}), expected[software]);
    assert.equal(spawned.length, before);
    assert.equal(JSON.parse(await readFile(path.join(directory, ".blocky-loader.json"), "utf8")).minecraft, "1.21.8");
  }
});
