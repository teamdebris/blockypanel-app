import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const data = await mkdtemp(path.join(os.tmpdir(), "blocky-addons-"));
process.env.BLOCKY_DATA = data;
const root = fileURLToPath(new URL("../", import.meta.url));
const bundled = await build({ stdin: { contents: ['modrinth', 'store', 'control', 'files', 'download', 'software'].map((name) => `export * from './src/server/${name}';`).join('\n'), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const core = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await rm(data, { recursive: true, force: true }); });
const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const sha = (value) => createHash("sha512").update(value).digest("hex");
const bytes = new Map();
const projects = new Map();
const versions = new Map();
const requests = [];
function project(id, versionId, dependencies = [], extras = {}) {
  const body = Buffer.from(`JAR bytes for ${id}/${versionId}`);
  bytes.set(versionId, body);
  projects.set(id, { id, slug: id.toLowerCase(), title: `Project ${id}`, description: "Test project", downloads: 123, server_side: "required", icon_url: null });
  versions.set(versionId, { id: versionId, project_id: id, version_number: versionId, version_type: "release", date_published: "2026-10-19T00:00:00Z", game_versions: ["1.21.8"], loaders: ["paper"], dependencies,
    files: [{ filename: `${id}.jar`, url: `https://cdn.modrinth.com/data/${versionId}.jar`, hashes: { sha512: sha(body) }, primary: true, size: body.length }], ...extras });
}
project("Deps0001", "DepV0001");
project("Root0001", "RootV001", [{ project_id: "Deps0001", dependency_type: "required", version_id: "DepV0001" }]);
project("Othr0001", "OthrV001", [{ project_id: "Deps0001", dependency_type: "required", version_id: "DepV0001" }]);
project("Opts0001", "OptsV001");
project("OptRoot1", "OptRV001", [{ project_id: "Opts0001", dependency_type: "optional" }]);
project("Deps0001", "DepV0002");
project("Confl001", "ConfV001", [{ project_id: "Deps0001", dependency_type: "required", version_id: "DepV0002" }]);
project("Incomp01", "IncoV001", [{ project_id: "Root0001", dependency_type: "incompatible" }]);
project("BadHash1", "BadHV001"); versions.get("BadHV001").files[0].hashes.sha512 = "0".repeat(128);
project("BadHost1", "BadUV001"); versions.get("BadUV001").files[0].url = "http://127.0.0.1/private.jar";
project("Beta0001", "BetaV001", [], { version_type: "beta" });

globalThis.fetch = async (input, options) => {
  const url = new URL(input); requests.push(url.href);
  if (url.hostname === "api.modrinth.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[1] === "version") return json(versions.get(parts[2]));
    if (parts[1] === "project" && parts[3] === "version") {
      assert.deepEqual(JSON.parse(url.searchParams.get("game_versions")), ["1.21.8"]);
      const found = [...versions.values()].filter((version) => version.project_id === parts[2]);
      return json(found.reverse());
    }
    if (parts[1] === "project") return json(projects.get(parts[2]));
    if (parts[1] === "search") return json({ total_hits: 1, hits: [{ ...projects.get("Root0001"), project_id: "Root0001", author: "Author" }] });
  }
  if (url.hostname === "cdn.modrinth.com") {
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private.jar" } });
    if (url.pathname === "/oversize") return new Response(new Uint8Array([0, 1, 2, 3, 4, 5]));
    const id = path.basename(url.pathname, ".jar");
    if (bytes.has(id)) { assert.equal(options.redirect, "manual"); return new Response(bytes.get(id)); }
  }
  if (url.hostname === "api.purpurmc.org") {
    if (url.pathname === "/v2/purpur") return json({ versions: ["1.20.4", "1.21.8"] });
    if (url.pathname.endsWith("/latest")) return json({ build: "2497", result: "SUCCESS", md5: createHash("md5").update("purpur jar").digest("hex") });
    if (url.pathname.endsWith("/download")) return new Response("purpur jar");
  }
  if (url.hostname === "meta.fabricmc.net") {
    if (url.pathname === "/v2/versions/game") return json([{ version: "1.21.8", stable: true }, { version: "26.1-snapshot", stable: false }]);
    if (url.pathname === "/v2/versions/installer") return json([{ version: "9.9.9", stable: false }, { version: "1.1.2", stable: true }]);
    if (url.pathname === "/v2/versions/loader/1.21.8") return json([{ loader: { version: "0.20.1", stable: false } }, { loader: { version: "0.19.5", stable: true } }]);
    if (url.pathname.endsWith("/0.19.5/1.1.2/server/jar")) return new Response("fabric launcher");
  }
  throw new Error(`Unexpected network request: ${url}`);
};
let port = 32000;
const server = () => core.addServer({ ...core.GAME_DEFAULTS, name: "Test", software: "paper", version: "1.21.8", memoryMb: 1024, port: port++, motd: "Test", maxPlayers: 10, difficulty: "normal", icon: "grass" });

test("Modrinth search applies the shared Linux compatibility filters", async () => {
  const instance = await server(); const result = await core.searchAddons(instance, "example");
  assert.equal(result.hits[0].id, "Root0001");
  const url = new URL(requests.find((url) => url.includes("/search?")));
  const facets = JSON.parse(url.searchParams.get("facets"));
  assert.ok(facets.some((list) => list.includes("versions:1.21.8")));
  assert.ok(facets.some((list) => list.includes("server_side:required")));
});

test("native installation resolves dependencies, preserves manual files and keeps shared dependencies", async () => {
  const instance = await server();
  const plan = await core.planAddon(instance, "Root0001");
  assert.equal(plan.added.length, 2); assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(core.installAddon(instance, "Root0001", false, "0".repeat(64)), /plan changed/);
  await core.installAddon(instance, "Root0001", false, plan.fingerprint);
  await core.uploadFile(instance.id, "plugins/manual.jar", Readable.from(["manual jar"]));
  assert.equal((await core.listAddons(instance)).installed.length, 2);
  assert.deepEqual((await core.listAddons(instance)).otherFiles, ["manual.jar"]);
  const next = await core.planAddon(instance, "Othr0001");
  await core.installAddon(instance, "Othr0001", false, next.fingerprint);
  await core.removeAddon(instance, "Root0001");
  const remaining = (await core.getControl(instance.id)).addons;
  assert.deepEqual(remaining.map((addon) => addon.projectId).sort(), ["Deps0001", "Othr0001"]);
  await assert.rejects(core.removeAddon(instance, "Deps0001"), /needs this dependency/);
  const managed = remaining.find((addon) => addon.projectId === "Othr0001");
  const managedPath = path.join(data, "servers", instance.id, "plugins", managed.file);
  await writeFile(managedPath, "changed outside the panel");
  await assert.rejects(core.removeAddon(instance, "Othr0001"), /changed outside the panel/);
  await writeFile(managedPath, bytes.get(managed.versionId));
  await core.removeAddon(instance, "Othr0001");
  assert.equal((await core.getControl(instance.id)).addons.length, 0);
  assert.equal(await readFile(path.join(data, "servers", instance.id, "plugins/manual.jar"), "utf8"), "manual jar");
});

test("dependency preview handles optional projects, incompatible projects and conflicting pins", async () => {
  const instance = await server();
  assert.equal((await core.planAddon(instance, "OptRoot1", false)).projects.length, 1);
  assert.equal((await core.planAddon(instance, "OptRoot1", true)).projects.length, 2);
  await core.installAddon(instance, "Root0001");
  await assert.rejects(core.planAddon(instance, "Confl001"), /different versions/);
  await assert.rejects(core.planAddon(instance, "Incomp01"), /incompatible/);
  await assert.rejects(core.planAddon(instance, "Beta0001"), /no stable release/);
  await assert.rejects(core.planAddon(instance, "BadHost1"), /unsupported host/);
});

test("checksum failures leave installed projects unchanged and remove staged files", async () => {
  const instance = await server(); await core.installAddon(instance, "Root0001");
  const before = (await core.getControl(instance.id)).addons;
  await assert.rejects(core.installAddon(instance, "BadHash1"), /checksum/);
  assert.deepEqual((await core.getControl(instance.id)).addons, before);
  assert.deepEqual(await readdir(path.join(data, "staging")), []);
});

test("download limits and redirect checks reject private hosts before fetching them", async () => {
  const target = path.join(data, "download.jar");
  await assert.rejects(core.download("https://cdn.modrinth.com/redirect", target, { allowedHosts: ["cdn.modrinth.com"] }), /approved HTTPS host/);
  assert.ok(!requests.some((url) => url.startsWith("http://127.0.0.1")));
  await assert.rejects(core.download("https://cdn.modrinth.com/oversize", target, { maxBytes: 4, allowedHosts: ["cdn.modrinth.com"] }), /larger/);
  assert.ok(!(await readdir(data)).some((file) => file.endsWith(".part") || file === "download.jar"));
});

test("Purpur checks its published checksum and Fabric selects stable bootstrap versions", async () => {
  assert.deepEqual(await core.versions("purpur"), ["1.21.8", "1.20.4"]);
  assert.deepEqual(await core.versions("fabric"), ["1.21.8"]);
  await core.downloadServerJar("purpur", "1.21.8", path.join(data, "purpur.jar"), () => {});
  assert.equal(await readFile(path.join(data, "purpur.jar"), "utf8"), "purpur jar");
  await core.downloadServerJar("fabric", "1.21.8", path.join(data, "fabric.jar"), () => {});
  assert.equal(await readFile(path.join(data, "fabric.jar"), "utf8"), "fabric launcher");
});
