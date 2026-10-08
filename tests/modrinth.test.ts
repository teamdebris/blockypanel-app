import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveVersion, isModrinthId, loaderSteps, modrinthEnv, modrinthTarget, pickRelease, projectListChanges, safeIconUrl, searchFacets, sortDependencies } from "../lib/modrinth-core.ts";

test("server types map to plugins, mods, or nothing", () => {
  assert.deepEqual(modrinthTarget("PAPER"), { kind: "plugin", label: "Plugins", folder: "plugins", loaders: ["paper", "spigot"] });
  assert.deepEqual(modrinthTarget("PURPUR")?.loaders, ["purpur", "paper", "spigot"]);
  assert.deepEqual(modrinthTarget("FABRIC"), { kind: "mod", label: "Mods", folder: "mods", loaders: ["fabric"] });
  assert.deepEqual(modrinthTarget("QUILT")?.loaders, ["quilt", "fabric"]);
  assert.deepEqual(modrinthTarget("NEOFORGE")?.loaders, ["neoforge"]);
  assert.equal(modrinthTarget("VANILLA"), null);
});

test("search facets filter by loader, version, type, and server support", () => {
  // Modrinth indexes plugins as project_type "plugin" in search (verified against the live API).
  assert.deepEqual(JSON.parse(searchFacets("PAPER", "1.21.8")!), [
    ["categories:paper", "categories:spigot"], ["versions:1.21.8"], ["project_type:plugin"], ["server_side:required", "server_side:optional"],
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

test("project icons are only shown from Modrinth's own hosts over https", () => {
  assert.equal(safeIconUrl("https://cdn.modrinth.com/data/abc/icon.png"), "https://cdn.modrinth.com/data/abc/icon.png");
  for (const url of ["http://cdn.modrinth.com/icon.png", "https://evil.example/modrinth.com/icon.png", "https://notmodrinth.com/icon.png", "javascript:alert(1)", "", null, undefined, 42]) {
    assert.equal(safeIconUrl(url), null, String(url));
  }
});

test("loader steps follow the image: the server's own loader, then the ones it's compatible with", () => {
  assert.deepEqual(loaderSteps("PAPER"), [["paper"], ["spigot"]], "bukkit-only plugins aren't downloaded by the image");
  assert.deepEqual(loaderSteps("PURPUR"), [["purpur"], ["paper", "spigot"]]);
  assert.deepEqual(loaderSteps("NEOFORGE"), [["neoforge"], ["forge"]]);
  assert.deepEqual(loaderSteps("FABRIC"), [["fabric"]]);
  assert.deepEqual(loaderSteps("VANILLA"), []);
});

test("optional dependencies switch the image to optional, which includes required ones", () => {
  assert.equal(modrinthEnv([], true)[1], "MODRINTH_DOWNLOAD_DEPENDENCIES=optional");
  assert.equal(modrinthEnv([])[1], "MODRINTH_DOWNLOAD_DEPENDENCIES=required");
});

test("LATEST and SNAPSHOT are checked against the version the server last ran", () => {
  assert.equal(effectiveVersion("1.21.8", "26.3"), "1.21.8", "a set version wins");
  assert.equal(effectiveVersion("LATEST", "26.3"), "26.3");
  assert.equal(effectiveVersion("LATEST"), undefined);
  assert.equal(effectiveVersion("SNAPSHOT", "26w14a"), undefined, "snapshots aren't matched");
});

const version = (id: string, type: string, at: string) => ({ id, version_type: type, date_published: at });

test("the image installs the newest release, and refuses betas", () => {
  const picked = pickRelease([version("old", "release", "2026-01-01"), version("beta", "beta", "2026-03-01"), version("new", "release", "2026-02-01")]);
  assert.equal(picked.status === "ok" && picked.version.id, "new");
  const betas = pickRelease([version("b1", "beta", "2026-01-01"), version("a2", "alpha", "2026-02-01")]);
  assert.equal(betas.status, "no-release");
  assert.equal(betas.status === "no-release" && betas.newest.id, "a2");
  assert.deepEqual(pickRelease([]), { status: "no-files" });
});

test("dependencies are sorted by kind, skipping embedded and external ones", () => {
  assert.deepEqual(sortDependencies([
    { project_id: "P7dR8mSH", version_id: null, dependency_type: "required" },
    { project_id: "P7dR8mSH", version_id: "abc", dependency_type: "required" },
    { project_id: "mOgUt4GM", dependency_type: "optional" },
    { project_id: "AANobbMI", dependency_type: "incompatible" },
    { project_id: "embedded", dependency_type: "embedded" },
    { project_id: null, version_id: null, dependency_type: "required" },
    { project_id: null, version_id: "Vpin1234", dependency_type: "required" },
  ]), {
    required: [{ projectId: "P7dR8mSH", versionId: undefined }, { projectId: undefined, versionId: "Vpin1234" }],
    optional: [{ projectId: "mOgUt4GM", versionId: undefined }],
    incompatible: [{ projectId: "AANobbMI", versionId: undefined }],
  });
});
