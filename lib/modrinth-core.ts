/**
 * Pure Modrinth helpers shared by the server, the UI, and tests. The itzg image does the actual
 * installing: given MODRINTH_PROJECTS it downloads matching versions into plugins/ or mods/ on
 * every start, pulls in required dependencies, and deletes files for projects removed from the list.
 */

type ServerType = "PAPER" | "PURPUR" | "VANILLA" | "FABRIC" | "QUILT" | "FORGE" | "NEOFORGE";

export type ModrinthTarget = { kind: "plugin" | "mod"; label: "Plugins" | "Mods"; folder: "plugins" | "mods"; loaders: string[] };

const TARGETS: Record<ServerType, ModrinthTarget | null> = {
  PAPER: { kind: "plugin", label: "Plugins", folder: "plugins", loaders: ["paper", "spigot"] },
  PURPUR: { kind: "plugin", label: "Plugins", folder: "plugins", loaders: ["purpur", "paper", "spigot"] },
  FABRIC: { kind: "mod", label: "Mods", folder: "mods", loaders: ["fabric"] },
  QUILT: { kind: "mod", label: "Mods", folder: "mods", loaders: ["quilt", "fabric"] },
  FORGE: { kind: "mod", label: "Mods", folder: "mods", loaders: ["forge"] },
  NEOFORGE: { kind: "mod", label: "Mods", folder: "mods", loaders: ["neoforge"] },
  VANILLA: null,
};

export const MAX_MODRINTH_PROJECTS = 100;

/**
 * The loaders the image asks Modrinth for, in order: the server's own first, then (only if that finds
 * nothing) the ones it's compatible with. Mirrors mc-image-helper's Loader enum, so the panel predicts
 * the same files the image downloads.
 */
const LOADER_STEPS: Record<ServerType, string[][]> = {
  PAPER: [["paper"], ["spigot"]],
  PURPUR: [["purpur"], ["paper", "spigot"]],
  FABRIC: [["fabric"]],
  QUILT: [["quilt"], ["fabric"]],
  FORGE: [["forge"]],
  NEOFORGE: [["neoforge"], ["forge"]],
  VANILLA: [],
};

export function loaderSteps(type: ServerType) {
  return LOADER_STEPS[type] ?? [];
}

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
export function modrinthEnv(projects: string[], optionalDependencies = false) {
  return [`MODRINTH_PROJECTS=${projects.join(",")}`, `MODRINTH_DOWNLOAD_DEPENDENCIES=${optionalDependencies ? "optional" : "required"}`, "MODRINTH_PROJECTS_DEFAULT_VERSION_TYPE=release"];
}

/** The Minecraft version to check against: the configured one, or for LATEST and SNAPSHOT the one the server last reported running. */
export function effectiveVersion(version: string, runningVersion?: string) {
  return concreteVersion(version) ?? (runningVersion && concreteVersion(runningVersion)) ?? undefined;
}

export type VersionPick<T> = { status: "ok"; version: T } | { status: "no-files" } | { status: "no-release"; newest: T };

/**
 * The version the image installs from a project's versions for one loader step: the newest release.
 * Without any release it refuses to start ("no-release"); without any versions it tries the next step.
 */
export function pickRelease<T extends { version_type: string; date_published: string }>(versions: T[]): VersionPick<T> {
  if (!versions.length) return { status: "no-files" };
  const newestFirst = [...versions].sort((a, b) => b.date_published.localeCompare(a.date_published));
  const release = newestFirst.find((version) => version.version_type === "release");
  return release ? { status: "ok", version: release } : { status: "no-release", newest: newestFirst[0] };
}

export type DependencyKind = "required" | "optional" | "incompatible" | "embedded";
type ApiDependency = { project_id?: string | null; version_id?: string | null; dependency_type: string };

/**
 * A version's dependencies on other Modrinth projects, by kind. Embedded ones ship inside the jar,
 * and ones with neither a project nor a version are external files the image can't fetch; both are
 * left out. A dependency pinned to a version but not a project keeps the version so it can be looked up.
 */
export function sortDependencies(dependencies: ApiDependency[]) {
  const result: Record<"required" | "optional" | "incompatible", { projectId?: string; versionId?: string }[]> = { required: [], optional: [], incompatible: [] };
  for (const dependency of dependencies) {
    const kind = dependency.dependency_type;
    if (kind !== "required" && kind !== "optional" && kind !== "incompatible") continue;
    const projectId = dependency.project_id || undefined;
    const versionId = dependency.version_id || undefined;
    if (!projectId && !versionId) continue;
    if (result[kind].some((item) => (projectId && item.projectId === projectId) || (!projectId && item.versionId === versionId))) continue;
    result[kind].push({ projectId, versionId });
  }
  return result;
}

/** Names added and removed between two project lists, for the apply confirmation. */
export function projectListChanges(before: string[], after: string[], names: Record<string, string>) {
  const name = (id: string) => names[id] || id;
  return { added: after.filter((id) => !before.includes(id)).map(name), removed: before.filter((id) => !after.includes(id)).map(name) };
}

/** A project icon to show, or null: only https links from Modrinth's own hosts, since the address comes from a third party. */
export function safeIconUrl(url: unknown) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)modrinth\.com$/i.test(parsed.hostname) ? url : null;
  } catch { return null; }
}
