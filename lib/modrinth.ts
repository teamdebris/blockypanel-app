import "server-only";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { anchorDirectory, openRegularFile } from "@/lib/anchored-paths";
import { HttpError } from "@/lib/errors";
import { concreteVersion, loaderSteps, modrinthTarget, pickRelease, safeIconUrl, searchFacets, sortDependencies, type VersionPick } from "@/lib/modrinth-core";
import { serverDataPath } from "@/lib/paths";
import packageJson from "@/package.json";

type ServerType = Parameters<typeof modrinthTarget>[0];

const API = "https://api.modrinth.com/v2";
// Modrinth asks every client to identify itself.
const USER_AGENT = `blocky-panel/${packageJson.version} (+https://github.com/teamdebris/blockypanel-app)`;
const SEARCH_TTL = 5 * 60_000;
const PROJECT_TTL = 10 * 60_000;

type ApiProject = { id: string; slug: string; title: string; description: string; icon_url: string | null; downloads: number; loaders: string[]; game_versions: string[]; server_side: string; project_type: string };
type ApiHit = { project_id: string; slug: string; title: string; description: string; icon_url: string | null; downloads: number; author: string; categories: string[] };
type ApiVersion = { id: string; project_id: string; version_number: string; version_type: string; date_published: string };

type ApiFullVersion = ApiVersion & { dependencies: { project_id?: string | null; version_id?: string | null; dependency_type: string }[] };

type ModrinthProject = { id: string; slug: string; title: string; description: string; iconUrl: string | null; downloads: number; author?: string; projectUrl: string };

async function modrinth<T>(pathname: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${pathname}`, {
      method: init?.method || "GET",
      headers: { "User-Agent": USER_AGENT, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new HttpError(502, "Modrinth didn't respond. Try again in a moment."); }
  if (response.status === 429) throw new HttpError(429, "Modrinth is rate-limiting this panel. Try again in a minute.");
  if (!response.ok) throw new HttpError(502, `Modrinth returned an error (${response.status}). Try again in a moment.`);
  return await response.json() as T;
}

function projectUrl(kind: "plugin" | "mod", slug: string) {
  return `https://modrinth.com/${kind}/${slug}`;
}

// Small in-memory caches keep search typing and tab polling well under Modrinth's rate limit.
const searchCache = new Map<string, { at: number; value: { hits: ModrinthProject[]; total: number } }>();
const projectCache = new Map<string, { at: number; value: ApiProject }>();

function remember<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
}

export async function searchProjects(query: string, type: ServerType, version: string, offset = 0) {
  const facets = searchFacets(type, version);
  const target = modrinthTarget(type);
  if (!facets || !target) throw new HttpError(400, "Vanilla servers don't load plugins or mods.");
  const key = JSON.stringify([query.trim().toLowerCase(), facets, offset]);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.value;
  const params = new URLSearchParams({ query: query.trim(), facets, limit: "20", offset: String(offset), index: query.trim() ? "relevance" : "downloads" });
  const result = await modrinth<{ hits: ApiHit[]; total_hits: number }>(`/search?${params}`);
  const value = {
    total: result.total_hits,
    hits: result.hits.map((hit) => ({ id: hit.project_id, slug: hit.slug, title: hit.title, description: hit.description, iconUrl: safeIconUrl(hit.icon_url), downloads: hit.downloads, author: hit.author, projectUrl: projectUrl(target.kind, hit.slug) })),
  };
  remember(searchCache, key, value);
  return value;
}

async function projectsById(ids: string[]) {
  const missing = ids.filter((id) => { const cached = projectCache.get(id); return !cached || Date.now() - cached.at >= PROJECT_TTL; });
  if (missing.length) {
    const fetched = await modrinth<ApiProject[]>(`/projects?${new URLSearchParams({ ids: JSON.stringify(missing) })}`);
    for (const project of fetched) remember(projectCache, project.id, project);
  }
  return new Map(ids.flatMap((id) => { const cached = projectCache.get(id); return cached ? [[id, cached.value] as const] : []; }));
}

/** Whether a project has builds for this server's loader and (concrete) Minecraft version. */
function compatible(project: ApiProject, type: ServerType, version: string) {
  const target = modrinthTarget(type);
  if (!target || !project.loaders.some((loader) => target.loaders.includes(loader))) return false;
  const concrete = concreteVersion(version);
  return !concrete || project.game_versions.includes(concrete);
}

/** Projects in `ids` that won't load after switching to `type` + `version` (e.g. before a version upgrade). */
export async function incompatibleProjects(ids: string[], type: ServerType, version: string) {
  if (!ids.length) return [];
  const projects = await projectsById(ids);
  return ids.filter((id) => { const project = projects.get(id); return !project || !compatible(project, type, version); })
    .map((id) => ({ id, title: projects.get(id)?.title || id }));
}

// Hashing large mod jars on every poll would be wasteful; a file's hash only changes with its size or mtime.
const hashCache = new Map<string, { size: number; mtimeMs: number; sha1: string }>();

// Real plugins and mods are well under this; anything bigger isn't worth hashing on a page load.
const MAX_JAR_BYTES = 256 * 1024 ** 2;

/**
 * Hashes a file opened without following links, so a planted symlink can't point it elsewhere. The
 * jar can be swapped (for a FIFO, or something huge) after the lstat, so the opened file is checked
 * again and the size limit applies to the bytes actually hashed.
 */
async function sha1(file: string, cacheKey: string, size: number, mtimeMs: number) {
  const cached = hashCache.get(cacheKey);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.sha1;
  const opened = await openRegularFile(file, constants.O_RDONLY);
  if (!opened) return undefined;
  const { handle } = opened;
  try {
    if (opened.info.size > MAX_JAR_BYTES) return undefined;
    const hash = createHash("sha1");
    let hashed = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, end: MAX_JAR_BYTES })) {
      hashed += (chunk as Buffer).length;
      if (hashed > MAX_JAR_BYTES) return undefined;
      hash.update(chunk as Buffer);
    }
    const value = hash.digest("hex");
    hashCache.set(cacheKey, { size, mtimeMs, sha1: value });
    if (hashCache.size > 5000) hashCache.delete(hashCache.keys().next().value!);
    return value;
  } finally { await handle.close(); }
}

/**
 * Jars in plugins/ or mods/. The game server writes these folders, so links are never followed:
 * a plugin could otherwise point the panel at files outside the server's data (lstat, O_NOFOLLOW).
 */
async function jarsIn(serverId: string, folder: string) {
  const directory = await anchorDirectory(serverDataPath(serverId), folder).catch(() => undefined);
  if (!directory) return [];
  try {
    const names = (await readdir(directory.path).catch(() => [])).filter((name) => name.toLowerCase().endsWith(".jar"));
    const jars: { name: string; size: number; sha1: string }[] = [];
    for (const name of names.slice(0, 500)) {
      const file = path.join(directory.path, name);
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_JAR_BYTES) continue;
      const hash = await sha1(file, path.join(serverDataPath(serverId), folder, name), info.size, info.mtimeMs).catch(() => undefined);
      if (hash) jars.push({ name, size: info.size, sha1: hash });
    }
    return jars;
  } finally { await directory.close(); }
}

/** Jar file names in plugins/ or mods/, without reading them. Links are skipped, as everywhere in data/. */
export async function jarFileNames(serverId: string, folder: string) {
  const directory = await anchorDirectory(serverDataPath(serverId), folder).catch(() => undefined);
  if (!directory) return [];
  try {
    const entries = await readdir(directory.path, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jar")).map((entry) => entry.name).slice(0, 500);
  } finally { await directory.close(); }
}

// Everyone who opens the tab triggers these lookups; cache them so polling can't get the panel
// rate-limited by Modrinth.
const versionCache = new Map<string, { at: number; value: [Record<string, ApiVersion>, Record<string, ApiVersion>] }>();

async function versionsForHashes(hashes: string[], loaders: string[], concrete: string | undefined) {
  const key = JSON.stringify([[...hashes].sort(), loaders, concrete]);
  const cached = versionCache.get(key);
  if (cached && Date.now() - cached.at < PROJECT_TTL) return cached.value;
  const value = await Promise.all([
    modrinth<Record<string, ApiVersion>>("/version_files", { method: "POST", body: { hashes, algorithm: "sha1" } }),
    modrinth<Record<string, ApiVersion>>("/version_files/update", { method: "POST", body: { hashes, algorithm: "sha1", loaders, ...(concrete ? { game_versions: [concrete] } : {}) } }),
  ]);
  remember(versionCache, key, value);
  return value;
}

type InstalledProject = ModrinthProject & { installed?: { version: string; file: string }; update?: string; compatible: boolean; available: boolean };
type OtherJar = { file: string; size: number; project?: { title: string; projectUrl: string } };

/**
 * The server's Modrinth list with what's actually on disk. Jars are identified by hash through
 * Modrinth's version-file lookup, so this doesn't depend on the image's internal bookkeeping.
 * `other` holds jars that aren't on the list: required dependencies the image pulled in, and
 * files added by hand.
 */
export async function installedProjects(serverId: string, server: { type: ServerType; version: string; modrinthProjects: string[] }, demo = false) {
  const target = modrinthTarget(server.type);
  if (!target) return { projects: [] as InstalledProject[], other: [] as OtherJar[] };
  const jars = demo ? [] : await jarsIn(serverId, target.folder);
  const hashes = jars.map((jar) => jar.sha1);
  const concrete = concreteVersion(server.version);
  const [versions, updates] = hashes.length ? await versionsForHashes(hashes, target.loaders, concrete) : [{}, {}];
  const identifiedIds = [...new Set(Object.values(versions).map((version) => version.project_id))];
  const details = await projectsById([...new Set([...server.modrinthProjects, ...identifiedIds])]);

  const projects: InstalledProject[] = server.modrinthProjects.map((id) => {
    const project = details.get(id);
    const jar = jars.find((item) => versions[item.sha1]?.project_id === id);
    const installed = jar ? versions[jar.sha1] : undefined;
    const latest = jar ? updates[jar.sha1] : undefined;
    return {
      id, slug: project?.slug || id, title: project?.title || id, description: project?.description || "", iconUrl: safeIconUrl(project?.icon_url), downloads: project?.downloads || 0,
      projectUrl: projectUrl(target.kind, project?.slug || id),
      installed: jar && installed ? { version: installed.version_number, file: jar.name } : demo ? { version: "latest", file: `${project?.slug || id}.jar` } : undefined,
      update: installed && latest && latest.id !== installed.id ? latest.version_number : undefined,
      compatible: project ? compatible(project, server.type, server.version) : false,
      available: Boolean(project),
    };
  });
  const other: OtherJar[] = jars.filter((jar) => !server.modrinthProjects.includes(versions[jar.sha1]?.project_id)).map((jar) => {
    const project = versions[jar.sha1] ? details.get(versions[jar.sha1].project_id) : undefined;
    return { file: jar.name, size: jar.size, project: project ? { title: project.title, projectUrl: projectUrl(target.kind, project.slug) } : undefined };
  });
  return { projects, other };
}

// Version lists change when a project publishes; ten minutes keeps a busy tab well under the rate limit.
const projectVersionsCache = new Map<string, { at: number; value: ApiFullVersion[] }>();
const versionByIdCache = new Map<string, { at: number; value: ApiFullVersion }>();

async function projectVersions(id: string, loaders: string[], gameVersion: string | undefined) {
  const key = JSON.stringify([id, loaders, gameVersion ?? null]);
  const cached = projectVersionsCache.get(key);
  if (cached && Date.now() - cached.at < PROJECT_TTL) return cached.value;
  const params = new URLSearchParams({ loaders: JSON.stringify(loaders), ...(gameVersion ? { game_versions: JSON.stringify([gameVersion]) } : {}) });
  const value = await modrinth<ApiFullVersion[]>(`/project/${encodeURIComponent(id)}/version?${params}`);
  remember(projectVersionsCache, key, value);
  return value;
}

async function versionById(id: string) {
  const cached = versionByIdCache.get(id);
  if (cached && Date.now() - cached.at < PROJECT_TTL) return cached.value;
  const value = await modrinth<ApiFullVersion>(`/version/${encodeURIComponent(id)}`);
  remember(versionByIdCache, id, value);
  return value;
}

/** The version the image would download for a project, trying each loader step in turn as it does. */
async function imagePick(id: string, type: ServerType, gameVersion: string | undefined): Promise<VersionPick<ApiFullVersion>> {
  for (const loaders of loaderSteps(type)) {
    const pick = pickRelease(await projectVersions(id, loaders, gameVersion));
    if (pick.status !== "no-files") return pick;
  }
  return { status: "no-files" };
}

type PickStatus = "ok" | "no-files" | "no-release" | "unavailable";
type Pick = { status: PickStatus; version?: ApiFullVersion };
export type DependencyInfo = { id: string; title: string; projectUrl: string; status: PickStatus; version?: string };
export type ProjectPlan = {
  status: PickStatus;
  /** The version the server will download. */
  version?: string;
  /** Downloaded with it, including dependencies of dependencies. */
  installs: DependencyInfo[];
  /** Its optional dependencies, listed while optional dependencies are off (when on, they're in `installs`). */
  optional: DependencyInfo[];
  /** Projects on the list, or downloaded with it, that this one says it doesn't work with. */
  conflicts: DependencyInfo[];
};

// A plugin with a runaway dependency tree shouldn't turn one page load into hundreds of requests.
const MAX_DEPENDENCY_LOOKUPS = 60;

/**
 * What the image will download for each project on the list: the version it picks, the dependencies
 * that come with it, and anything that will stop the server starting. Follows the image's rules: the
 * newest release for the loader steps and Minecraft version, required dependencies (and optional ones
 * when they're switched on) followed all the way down, and projects on the list never pulled in again
 * as someone's dependency. Without a known Minecraft version (LATEST before the server has run), the
 * picks are the newest release for any version, so `exact` is false.
 */
export async function dependencyPlan(ids: string[], type: ServerType, gameVersion: string | undefined, includeOptional: boolean) {
  const target = modrinthTarget(type);
  if (!target || !ids.length) return { exact: Boolean(gameVersion), projects: {} as Record<string, ProjectPlan> };
  const explicit = new Set(ids);
  const details = await projectsById(ids);
  // Each project's pick, shared between everything that depends on it.
  const picks = new Map<string, Promise<Pick>>();
  const pickProject = (id: string) => {
    let pending = picks.get(id);
    if (!pending) {
      pending = picks.size >= MAX_DEPENDENCY_LOOKUPS ? Promise.resolve<Pick>({ status: "ok" })
        : imagePick(id, type, gameVersion).then((pick): Pick => pick.status === "ok" ? { status: "ok", version: pick.version } : { status: pick.status }, (): Pick => ({ status: "unavailable" }));
      picks.set(id, pending);
    }
    return pending;
  };
  // A dependency pinned to a version is downloaded as that version, whatever the Minecraft version.
  const pickDependency = async (dependency: { projectId?: string; versionId?: string }): Promise<Pick & { projectId?: string }> => {
    if (dependency.versionId) {
      const version = await versionById(dependency.versionId).catch(() => undefined);
      return { projectId: version?.project_id || dependency.projectId, status: version ? "ok" : "unavailable", version };
    }
    return { projectId: dependency.projectId, ...(await pickProject(dependency.projectId!)) };
  };

  type Working = Pick & { installs: Map<string, Pick>; optional: Set<string>; incompatible: Set<string> };
  const plans: Record<string, Working> = {};
  await Promise.all(ids.map(async (id) => {
    const own: Pick = details.has(id) ? await pickProject(id) : { status: "unavailable" };
    const plan: Working = { ...own, installs: new Map(), optional: new Set(), incompatible: new Set() };
    plans[id] = plan;
    const queue = own.version ? [own.version] : [];
    for (let version = queue.shift(); version; version = queue.shift()) {
      const sorted = sortDependencies(version.dependencies || []);
      for (const dependency of sorted.incompatible) if (dependency.projectId) plan.incompatible.add(dependency.projectId);
      if (!includeOptional && version === own.version) {
        for (const dependency of sorted.optional) if (dependency.projectId && !explicit.has(dependency.projectId)) plan.optional.add(dependency.projectId);
      }
      for (const dependency of includeOptional ? [...sorted.required, ...sorted.optional] : sorted.required) {
        if (dependency.projectId && (explicit.has(dependency.projectId) || plan.installs.has(dependency.projectId))) continue;
        const picked = await pickDependency(dependency);
        if (!picked.projectId || explicit.has(picked.projectId) || plan.installs.has(picked.projectId)) continue;
        plan.installs.set(picked.projectId, { status: picked.status, version: picked.version });
        if (picked.version) queue.push(picked.version);
      }
    }
  }));

  const mentioned = [...new Set(Object.values(plans).flatMap((plan) => [...plan.installs.keys(), ...plan.optional, ...plan.incompatible]))];
  const names = mentioned.length ? await projectsById(mentioned).catch(() => new Map<string, ApiProject>()) : new Map<string, ApiProject>();
  const everything = new Set([...explicit, ...Object.values(plans).flatMap((plan) => [...plan.installs.keys()])]);
  const describe = (id: string, pick: Pick): DependencyInfo => {
    const project = names.get(id) || details.get(id);
    return { id, title: project?.title || id, projectUrl: projectUrl(target.kind, project?.slug || id), status: pick.status, version: pick.version?.version_number };
  };
  const projects: Record<string, ProjectPlan> = {};
  for (const [id, plan] of Object.entries(plans)) {
    projects[id] = {
      status: plan.status, version: plan.version?.version_number,
      installs: [...plan.installs].map(([dependency, pick]) => describe(dependency, pick)),
      optional: [...plan.optional].map((dependency) => describe(dependency, { status: "ok" })),
      conflicts: [...plan.incompatible].filter((other) => everything.has(other)).map((other) => describe(other, { status: "ok" })),
    };
  }
  return { exact: Boolean(gameVersion), projects };
}
