/**
 * Pure Modrinth helpers shared by the server, the UI, and tests. The itzg image does the actual
 * installing: given MODRINTH_PROJECTS it downloads matching versions into plugins/ or mods/ on
 * every start, pulls in required dependencies, and deletes files for projects removed from the list.
 */

type ServerType = "PAPER" | "PURPUR" | "VANILLA" | "FABRIC" | "QUILT" | "FORGE" | "NEOFORGE";

export type ModrinthTarget = { kind: "plugin" | "mod"; label: "Plugins" | "Mods"; folder: "plugins" | "mods"; loaders: string[] };

const TARGETS: Record<ServerType, ModrinthTarget | null> = {
  PAPER: { kind: "plugin", label: "Plugins", folder: "plugins", loaders: ["paper", "spigot", "bukkit"] },
  PURPUR: { kind: "plugin", label: "Plugins", folder: "plugins", loaders: ["purpur", "paper", "spigot", "bukkit"] },
  FABRIC: { kind: "mod", label: "Mods", folder: "mods", loaders: ["fabric"] },
  QUILT: { kind: "mod", label: "Mods", folder: "mods", loaders: ["quilt", "fabric"] },
  FORGE: { kind: "mod", label: "Mods", folder: "mods", loaders: ["forge"] },
  NEOFORGE: { kind: "mod", label: "Mods", folder: "mods", loaders: ["neoforge"] },
  VANILLA: null,
};

export const MAX_MODRINTH_PROJECTS = 100;

/** What this server type loads from Modrinth, or null (Vanilla loads neither plugins nor mods). */
export function modrinthTarget(type: ServerType): ModrinthTarget | null {
  return TARGETS[type] ?? null;
}

/** Modrinth project IDs are 8 base62 characters. IDs are stored instead of slugs because slugs can change. */
export function isModrinthId(value: string) {
  return /^[a-zA-Z0-9]{8}$/.test(value);
}

/** `version` is omitted from the filter when it's a moving target like LATEST or SNAPSHOT. */
export function concreteVersion(version: string) {
  return /^\d+\.\d+(\.\d+)?$/.test(version) ? version : undefined;
}

/** Search facets: OR within each inner list, AND between lists. Client-only projects are excluded. */
export function searchFacets(type: ServerType, version: string) {
  const target = modrinthTarget(type);
  if (!target) return null;
  const facets: string[][] = [target.loaders.map((loader) => `categories:${loader}`)];
  const concrete = concreteVersion(version);
  if (concrete) facets.push([`versions:${concrete}`]);
  facets.push([`project_type:${target.kind}`], ["server_side:required", "server_side:optional"]);
  return JSON.stringify(facets);
}

/**
 * Environment for the itzg image. Required dependencies are downloaded too (the image's default is
 * none). MODRINTH_PROJECTS is set even when empty: the image skips its Modrinth step entirely when
 * the variable is absent, and that step is what deletes the files of removed projects. With an
 * empty list it makes no network calls and just cleans up.
 */
export function modrinthEnv(projects: string[]) {
  return [`MODRINTH_PROJECTS=${projects.join(",")}`, "MODRINTH_DOWNLOAD_DEPENDENCIES=required", "MODRINTH_PROJECTS_DEFAULT_VERSION_TYPE=release"];
}

/** Names added and removed between two project lists, for the apply confirmation. */
export function projectListChanges(before: string[], after: string[], names: Record<string, string>) {
  const name = (id: string) => names[id] || id;
  return { added: after.filter((id) => !before.includes(id)).map(name), removed: before.filter((id) => !after.includes(id)).map(name) };
}
