import assert from "node:assert/strict";
import { test } from "node:test";
import { isModrinthId, modrinthEnv, modrinthTarget, projectListChanges, searchFacets } from "../lib/modrinth-core.ts";

test("server types map to plugins, mods, or nothing", () => {
  assert.deepEqual(modrinthTarget("PAPER"), { kind: "plugin", label: "Plugins", folder: "plugins", loaders: ["paper", "spigot", "bukkit"] });
  assert.deepEqual(modrinthTarget("PURPUR")?.loaders, ["purpur", "paper", "spigot", "bukkit"]);
  assert.deepEqual(modrinthTarget("FABRIC"), { kind: "mod", label: "Mods", folder: "mods", loaders: ["fabric"] });
  assert.deepEqual(modrinthTarget("QUILT")?.loaders, ["quilt", "fabric"]);
  assert.deepEqual(modrinthTarget("NEOFORGE")?.loaders, ["neoforge"]);
  assert.equal(modrinthTarget("VANILLA"), null);
});

test("search facets filter by loader, version, type, and server support", () => {
  // Modrinth indexes plugins as project_type "plugin" in search (verified against the live API).
  assert.deepEqual(JSON.parse(searchFacets("PAPER", "1.21.8")!), [
    ["categories:paper", "categories:spigot", "categories:bukkit"], ["versions:1.21.8"], ["project_type:plugin"], ["server_side:required", "server_side:optional"],
  ]);
  assert.deepEqual(JSON.parse(searchFacets("FABRIC", "LATEST")!), [["categories:fabric"], ["project_type:mod"], ["server_side:required", "server_side:optional"]]);
  assert.equal(searchFacets("VANILLA", "1.21.8"), null);
});

test("Modrinth IDs are validated", () => {
  assert.equal(isModrinthId("Vebnzrzj"), true);
  assert.equal(isModrinthId("luckperms"), false);
  assert.equal(isModrinthId("Vebnzrz"), false);
  assert.equal(isModrinthId("Vebnzrz!"), false);
});

test("container env always lists the projects, even when there are none", () => {
  // The image only runs its Modrinth step (which deletes files of removed projects) when the
  // variable is set, so an empty list must still be passed or the last removal is never cleaned up.
  assert.deepEqual(modrinthEnv([]), ["MODRINTH_PROJECTS=", "MODRINTH_DOWNLOAD_DEPENDENCIES=required", "MODRINTH_PROJECTS_DEFAULT_VERSION_TYPE=release"]);
  assert.deepEqual(modrinthEnv(["Vebnzrzj", "AANobbMI"]), [
    "MODRINTH_PROJECTS=Vebnzrzj,AANobbMI", "MODRINTH_DOWNLOAD_DEPENDENCIES=required", "MODRINTH_PROJECTS_DEFAULT_VERSION_TYPE=release",
  ]);
});

test("pending changes are summarized by name", () => {
  const names = { Vebnzrzj: "LuckPerms", AANobbMI: "Sodium", P7dR8mSH: "Fabric API" };
  assert.deepEqual(projectListChanges(["Vebnzrzj", "AANobbMI"], ["Vebnzrzj", "P7dR8mSH"], names), { added: ["Fabric API"], removed: ["Sodium"] });
  assert.deepEqual(projectListChanges(["Vebnzrzj"], ["Vebnzrzj"], names), { added: [], removed: [] });
  assert.deepEqual(projectListChanges([], ["zzzzzzzz"], {}), { added: ["zzzzzzzz"], removed: [] });
});
