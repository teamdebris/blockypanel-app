import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isModrinthId, loaderSteps, modrinthTarget, pickRelease, safeIconUrl, searchFacets, type ModrinthTarget } from "../../../lib/modrinth-core";
import { createBackup } from "./backups";
import { changeControl, getControl, recordEvent, type InstalledAddon } from "./control";
import { download, getJson } from "./download";
import { HttpError } from "./errors";
import { assertFilesStopped, cleanPath, listFiles, makeDirectory, openDownload, safeTarget } from "./files";
import { isActive } from "./minecraft";
import { DATA_ROOT } from "./paths";
import type { ServerConfig } from "./store";

const API = "https://api.modrinth.com/v2";
const CDN = ["cdn.modrinth.com", "cdn-raw.modrinth.com"];
type Project = { id: string; slug: string; title: string; description: string; icon_url: string | null; downloads: number; server_side: string };
type Version = { id: string; project_id: string; version_number: string; version_type: string; date_published: string; game_versions: string[]; loaders: string[];
  dependencies: { project_id?: string | null; version_id?: string | null; dependency_type: string }[];
  files: { filename: string; url: string; hashes: { sha512?: string; sha1?: string }; primary: boolean; size: number }[] };
type Planned = InstalledAddon & { url: string; size: number };
export type AddonPlan = { fingerprint: string; projects: Planned[]; added: { title: string; version: string }[]; updated: { title: string; version: string }[]; removed: { title: string; version: string }[]; downloadBytes: number };
const cache = new Map<string, { at: number; value: unknown }>();

async function api<T>(route: string): Promise<T> {
  const cached = cache.get(route);
  if (cached && Date.now() - cached.at < 300000) return structuredClone(cached.value) as T;
  let value: T;
  try { value = await getJson<T>(`${API}${route}`); }
  catch (error) { throw new HttpError(502, `Modrinth could not be reached: ${error instanceof Error ? error.message : "try again shortly"}`); }
  cache.set(route, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return structuredClone(value);
}
const typeOf = (server: ServerConfig) => server.software.toUpperCase() as Parameters<typeof modrinthTarget>[0];
export function targetFor(server: ServerConfig): ModrinthTarget {
  const target = modrinthTarget(typeOf(server));
  if (!target) throw new HttpError(400, "Vanilla servers do not load plugins or mods.");
  return target;
}

export async function searchAddons(server: ServerConfig, query: string, offset = 0) {
  const target = targetFor(server);
  if (query.length > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new HttpError(400, "Invalid search.");
  const params = new URLSearchParams({ query: query.trim(), facets: searchFacets(typeOf(server), server.version)!, limit: "20", offset: String(offset), index: query.trim() ? "relevance" : "downloads" });
  const result = await api<{ hits: (Omit<Project, "id"> & { project_id: string; author: string })[]; total_hits: number }>(`/search?${params}`);
  return { total: result.total_hits, hits: result.hits.map((hit) => ({ id: hit.project_id, title: hit.title, description: hit.description, iconUrl: safeIconUrl(hit.icon_url), downloads: hit.downloads, projectUrl: `https://modrinth.com/${target.kind}/${encodeURIComponent(hit.slug)}` })) };
}

async function chooseVersion(server: ServerConfig, projectId: string, pinned?: string) {
  let chosen: Version | undefined;
  if (pinned) chosen = await api<Version>(`/version/${pinned}`);
  else {
    for (const loaders of loaderSteps(typeOf(server))) {
      const result = await api<Version[]>(`/project/${projectId}/version?${new URLSearchParams({ loaders: JSON.stringify(loaders), game_versions: JSON.stringify([server.version]) })}`);
      const picked = pickRelease(result);
      if (picked.status === "ok") { chosen = picked.version; break; }
      if (picked.status === "no-release") throw new HttpError(409, "This project has no stable release for this Minecraft version and loader.");
    }
  }
  if (!chosen || !isModrinthId(chosen.id) || chosen.project_id !== projectId || chosen.version_type !== "release" || !chosen.game_versions.includes(server.version) || !chosen.loaders.some((loader) => targetFor(server).loaders.includes(loader))) throw new HttpError(409, `No compatible stable release was found for project ${projectId}.`);
  return chosen;
}

export async function planAddon(server: ServerConfig, projectId: string, optionalDependencies = false): Promise<AddonPlan> {
  targetFor(server);
  if (!isModrinthId(projectId) || typeof optionalDependencies !== "boolean") throw new HttpError(400, "Choose a valid Modrinth project.");
  const installed = (await getControl(server.id)).addons ?? [];
  const roots = installed.filter((addon) => addon.requested && addon.projectId !== projectId).map((addon) => ({ id: addon.projectId, version: addon.versionId, optional: addon.optionalDependencies }));
  roots.push({ id: projectId, version: "", optional: optionalDependencies });
  const requested = new Map(roots.map((root) => [root.id, root]));
  const selected = new Map<string, Planned>();
  const versions = new Map<string, Version>();
  const started = Date.now();
  const visit = async (id: string, pinned: string | undefined, optional: boolean): Promise<void> => {
    if (!isModrinthId(id) || (pinned && !isModrinthId(pinned))) throw new HttpError(502, "Modrinth returned an invalid dependency identifier.");
    const previous = selected.get(id);
    if (previous) {
      if (pinned && previous.versionId !== pinned) throw new HttpError(409, `Two projects require different versions of ${previous.title}. Remove the conflicting project before installing.`);
      return;
    }
    if (selected.size >= 100 || Date.now() - started > 60000) throw new HttpError(400, "This dependency plan is too large. Install a smaller set of projects.");
    const chosen = await chooseVersion(server, id, pinned || requested.get(id)?.version || undefined);
    const project = await api<Project>(`/project/${id}`);
    if (project.server_side === "unsupported") throw new HttpError(409, `${project.title} only supports Minecraft clients.`);
    const file = chosen.files.find((file) => file.primary && /\.jar$/i.test(file.filename)) ?? chosen.files.find((file) => /\.jar$/i.test(file.filename));
    if (!file || !file.hashes.sha512 && !file.hashes.sha1 || file.size > 256 * 1024 ** 2) throw new HttpError(409, `${project.title} has no supported, checksummed JAR download.`);
    if (file.hashes.sha512 && !/^[a-f0-9]{128}$/i.test(file.hashes.sha512) || file.hashes.sha1 && !/^[a-f0-9]{40}$/i.test(file.hashes.sha1)) throw new HttpError(502, "Modrinth returned an invalid checksum.");
    const source = new URL(file.url);
    if (source.protocol !== "https:" || !CDN.includes(source.hostname)) throw new HttpError(502, "Modrinth returned a download from an unsupported host.");
    const selectedAddon: Planned = { projectId: id, versionId: chosen.id, title: project.title, version: chosen.version_number, file: `modrinth-${id}-${chosen.id}.jar`, requested: requested.has(id), optionalDependencies: requested.get(id)?.optional ?? false, dependencies: [], installedAt: new Date().toISOString(), sha512: file.hashes.sha512?.toLowerCase(), sha1: file.hashes.sha1?.toLowerCase(), url: file.url, size: file.size };
    selected.set(id, selectedAddon); versions.set(id, chosen);
    for (const dependency of chosen.dependencies) {
      if (dependency.dependency_type !== "required" && !(optional && dependency.dependency_type === "optional")) continue;
      let depId = dependency.project_id || undefined;
      if (!depId && dependency.version_id && isModrinthId(dependency.version_id)) depId = (await api<Version>(`/version/${dependency.version_id}`)).project_id;
      if (!depId) throw new HttpError(409, `${project.title} requires a dependency that must be installed manually.`);
      selectedAddon.dependencies.push(depId);
      await visit(depId, dependency.version_id || undefined, requested.get(depId)?.optional ?? optional);
    }
  };
  // Pin explicitly requested roots first, so transitive requirements cannot choose a conflicting version.
  for (const root of roots) await visit(root.id, root.version || undefined, root.optional);
  for (const [id, chosen] of versions) {
    for (const dependency of chosen.dependencies.filter((entry) => entry.dependency_type === "incompatible")) {
      let incompatibleId = dependency.project_id;
      if (!incompatibleId && dependency.version_id && isModrinthId(dependency.version_id)) incompatibleId = (await api<Version>(`/version/${dependency.version_id}`)).project_id;
      const other = incompatibleId && selected.get(incompatibleId);
      if (other && (!dependency.version_id || other.versionId === dependency.version_id)) throw new HttpError(409, `${selected.get(id)!.title} is incompatible with ${other.title}.`);
    }
  }
  const projects = [...selected.values()];
  const added = projects.filter((addon) => !installed.some((old) => old.projectId === addon.projectId));
  const updated = projects.filter((addon) => installed.some((old) => old.projectId === addon.projectId && old.versionId !== addon.versionId));
  const removed = installed.filter((old) => !selected.has(old.projectId));
  const fingerprint = createHash("sha256").update(JSON.stringify([server.software, server.version, projects.map((addon) => [addon.projectId, addon.versionId, addon.sha512, addon.sha1, addon.requested, addon.optionalDependencies, [...addon.dependencies].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])).digest("hex");
  return { fingerprint, projects, added, updated, removed, downloadBytes: [...added, ...updated].reduce((total, addon) => total + addon.size, 0) };
}

async function fileHash(serverId: string, relative: string, algorithm: "sha512" | "sha1") {
  const { handle, size } = await openDownload(serverId, relative);
  try {
    if (size > 256 * 1024 ** 2) throw new HttpError(409, "A managed JAR was replaced with an oversized file.");
    const hash = createHash(algorithm);
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

async function apply(server: ServerConfig, desired: InstalledAddon[], downloads: Planned[]) {
  assertFilesStopped(server.id);
  const target = targetFor(server);
  const previous = (await getControl(server.id)).addons ?? [];
  const removed = previous.filter((old) => !desired.some((item) => item.projectId === old.projectId && item.versionId === old.versionId));
  const stagedRoot = path.join(DATA_ROOT, "staging");
  const staging = path.join(stagedRoot, `${server.id}-${randomUUID()}`);
  const relative = path.relative(stagedRoot, staging);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid staging directory.");
  await mkdir(stagedRoot, { recursive: true });
  if ((await lstat(stagedRoot)).isSymbolicLink()) throw new HttpError(400, "The staging folder cannot be a link or junction.");
  await mkdir(staging);
  const moved: { source: string; original: string }[] = [];
  const added: string[] = [];
  let cleanup = true;
  try {
    for (const addon of downloads) {
      cleanPath(addon.file);
      await download(addon.url, path.join(staging, addon.file), { sha512: addon.sha512, sha1: addon.sha1, maxBytes: 256 * 1024 ** 2, allowedHosts: CDN });
    }
    try { await makeDirectory(server.id, target.folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await safeTarget(server.id, target.folder);
    for (const old of removed) {
      cleanPath(old.file);
      if (/[\\/]/.test(old.file)) throw new HttpError(400, "Invalid managed filename.");
      try {
        const expected = old.sha512 || old.sha1;
        if (!expected || await fileHash(server.id, `${target.folder}/${old.file}`, old.sha512 ? "sha512" : "sha1") !== expected) throw new HttpError(409, `${old.file} changed outside the panel. Move it aside before updating or removing it.`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const addon of downloads) {
      try { await safeTarget(server.id, `${target.folder}/${addon.file}`); throw new HttpError(409, `${addon.file} already exists. Move it aside first.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (removed.length || downloads.length) await createBackup(server.id, "safety");
    for (const old of removed) {
      try {
        const { target: original } = await safeTarget(server.id, `${target.folder}/${old.file}`);
        const source = path.join(staging, `old-${old.file}`);
        await rename(original, source); moved.push({ source, original });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const addon of downloads) {
      const { target: destination } = await safeTarget(server.id, `${target.folder}/${addon.file}`, true);
      await rename(path.join(staging, addon.file), destination); added.push(destination);
    }
    await changeControl(server.id, (state) => { state.addons = desired; });
  } catch (error) {
    try {
      for (const file of added) await rm(file, { force: true });
      for (const old of moved.reverse()) await rename(old.source, old.original);
    } catch (rollbackError) {
      cleanup = false;
      throw new HttpError(500, `The change failed and rollback could not finish. Original JAR files are preserved in ${staging}; a safety backup is also available. ${rollbackError instanceof Error ? rollbackError.message : ""}`);
    }
    throw error;
  } finally { if (cleanup) await rm(staging, { recursive: true, force: true }); }
}

export async function listAddons(server: ServerConfig) {
  const target = targetFor(server);
  const installed = (await getControl(server.id)).addons ?? [];
  let otherFiles: string[] = [];
  if (!isActive(server.id)) {
    try { otherFiles = (await listFiles(server.id, target.folder)).filter((entry) => entry.type === "file" && /\.jar$/i.test(entry.name) && !installed.some((addon) => addon.file === entry.name)).map((entry) => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { installed, otherFiles, target };
}

export async function installAddon(server: ServerConfig, projectId: string, optionalDependencies = false, expectedPlan?: string) {
  assertFilesStopped(server.id);
  const plan = await planAddon(server, projectId, optionalDependencies);
  if (expectedPlan && plan.fingerprint !== expectedPlan) throw new HttpError(409, "The dependency plan changed. Preview it again before installing.");
  const previous = (await getControl(server.id)).addons ?? [];
  const changed = plan.projects.filter((addon) => !previous.some((old) => old.projectId === addon.projectId && old.versionId === addon.versionId));
  const desired: InstalledAddon[] = plan.projects.map(({ url: _url, size: _size, ...addon }) => ({ ...addon, installedAt: previous.find((old) => old.projectId === addon.projectId && old.versionId === addon.versionId)?.installedAt || addon.installedAt }));
  await apply(server, desired, changed);
  await recordEvent(server.id, `Installed or updated ${plan.projects.find((addon) => addon.projectId === projectId)!.title} and its selected dependencies.`, "success");
  return { installed: desired };
}

export async function removeAddon(server: ServerConfig, projectId: string) {
  assertFilesStopped(server.id);
  if (!isModrinthId(projectId)) throw new HttpError(400, "Invalid project.");
  const previous = (await getControl(server.id)).addons ?? [];
  const selected = previous.find((addon) => addon.projectId === projectId);
  if (!selected) throw new HttpError(404, "That project is not installed.");
  const remaining = previous.map((addon) => ({ ...addon, requested: addon.projectId === projectId ? false : addon.requested }));
  const reachable = new Set<string>();
  const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const dependency of remaining.find((addon) => addon.projectId === id)?.dependencies ?? []) visit(dependency); };
  for (const root of remaining.filter((addon) => addon.requested)) visit(root.projectId);
  if (!selected.requested && reachable.has(projectId)) throw new HttpError(409, "Another installed project needs this dependency. Remove that project first.");
  const desired = remaining.filter((addon) => reachable.has(addon.projectId));
  await apply(server, desired, []);
  await recordEvent(server.id, `Removed the request for ${selected.title}; dependencies still needed by other projects were kept.`, "success");
  return { installed: desired };
}
