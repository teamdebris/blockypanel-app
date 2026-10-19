import { access, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { download, getJson } from "./download";
import { RUNTIME_DIR } from "./paths";
import type { Software } from "./store";
import { loaderVersions } from "./loaders";
import { extractArchive, listArchive } from "../../../lib/archive";

const run = promisify(execFile);
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RELEASE = /^\d+(\.\d+)+$/;

type Manifest = { latest: { release: string }; versions: { id: string; type: string; url: string }[] };
type VersionJson = { javaVersion?: { majorVersion: number }; downloads?: { server?: { url: string; sha1: string } } };

let manifest: { at: number; value: Manifest } | undefined;
async function mojang() {
  if (!manifest || Date.now() - manifest.at > 3_600_000) manifest = { at: Date.now(), value: await getJson<Manifest>(MANIFEST) };
  return manifest.value;
}

async function versionJson(version: string) {
  const entry = (await mojang()).versions.find((item) => item.id === version);
  if (!entry) throw new Error(`Minecraft ${version} isn't a known version.`);
  return getJson<VersionJson>(entry.url);
}

/** Release versions offered for each server type, newest first. */
export async function versions(software: Software): Promise<string[]> {
  if (software === "quilt" || software === "forge" || software === "neoforge") {
    const [available, manifest] = await Promise.all([loaderVersions(software), mojang()]);
    const releases = new Set(manifest.versions.filter((entry) => entry.type === "release").map((entry) => entry.id));
    return available.filter((version) => releases.has(version)).slice(0, 40);
  }
  if (software === "vanilla") return (await mojang()).versions.filter((item) => item.type === "release").map((item) => item.id).slice(0, 40);
  if (software === "purpur") {
    const project = await getJson<{ versions: string[] }>("https://api.purpurmc.org/v2/purpur");
    return project.versions.filter((version) => RELEASE.test(version)).reverse().slice(0, 40);
  }
  if (software === "fabric") {
    const releases = await getJson<{ version: string; stable: boolean }[]>("https://meta.fabricmc.net/v2/versions/game");
    return releases.filter((entry) => entry.stable && RELEASE.test(entry.version)).map((entry) => entry.version).slice(0, 40);
  }
  const project = await getJson<{ versions: Record<string, string[]> }>("https://fill.papermc.io/v3/projects/paper");
  return Object.values(project.versions).flat().filter((version) => RELEASE.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 40);
}

/** The Java version Minecraft needs (from Mojang's version info); 21 if it doesn't say. */
export async function javaFor(version: string) {
  return (await versionJson(version)).javaVersion?.majorVersion ?? 21;
}

/** Downloads the server jar for `software` and `version` to `target`, checking its checksum. */
export async function downloadServerJar(software: Software, version: string, target: string, onProgress: (fraction: number) => void) {
  if (software === "vanilla") {
    const server = (await versionJson(version)).downloads?.server;
    if (!server) throw new Error(`Minecraft ${version} has no server download.`);
    return download(server.url, target, { sha1: server.sha1, onProgress });
  }
  if (software === "purpur") {
    const build = await getJson<{ build: string; md5: string; result: string }>(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest`);
    if (build.result !== "SUCCESS" || !/^\d+$/.test(build.build) || !/^[a-f0-9]{32}$/i.test(build.md5)) throw new Error(`Purpur has no successful build for ${version}.`);
    return download(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${build.build}/download`, target, { md5: build.md5, onProgress });
  }
  if (software === "fabric") {
    const loaders = await getJson<{ loader: { version: string; stable: boolean } }[]>(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`);
    const installers = await getJson<{ version: string; stable: boolean }[]>("https://meta.fabricmc.net/v2/versions/installer");
    const loader = loaders.find((entry) => entry.loader.stable)?.loader.version;
    const installer = installers.find((entry) => entry.stable)?.version;
    if (!loader || !installer) throw new Error(`Fabric has no stable loader and installer for ${version}.`);
    // Fabric generates this launcher on demand over HTTPS and publishes no separate checksum.
    return download(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`, target, { onProgress });
  }
  type Build = { id: number; channel: string; downloads: Record<string, { url: string; checksums: { sha256: string } }> };
  const builds = await getJson<Build[]>(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
  const build = builds.find((item) => item.channel === "STABLE") ?? builds[0];
  const file = build?.downloads["server:default"];
  if (!file) throw new Error(`Paper has no build for ${version} yet.`);
  return download(file.url, target, { sha256: file.checksums.sha256, onProgress });
}

const javaHome = (major: number) => path.join(RUNTIME_DIR, `java-${major}`);

async function findJava(dir: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dir, entry.name, "bin", "java.exe");
    try { await access(candidate); await run(candidate, ["-version"], { windowsHide: true, timeout: 10000 }); return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

/** java.exe for `major`, downloading Eclipse Temurin (a free OpenJDK build) the first time. */
async function installJava(major: number, onProgress: (fraction: number) => void) {
  const home = javaHome(major);
  await mkdir(RUNTIME_DIR, { recursive: true });
  if ((await lstat(RUNTIME_DIR)).isSymbolicLink()) throw new Error("The runtime folder cannot be a link or junction.");
  await mkdir(home, { recursive: true });
  if ((await lstat(home)).isSymbolicLink()) throw new Error("The Java folder cannot be a link or junction.");
  const existing = await findJava(home);
  if (existing) return existing;
  type Asset = { binary: { package: { name: string; link: string; checksum: string } } };
  const assets = await getJson<Asset[]>(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`);
  const zip = assets.map((asset) => asset.binary.package).find((item) => item.name.endsWith(".zip"));
  if (!zip) throw new Error(`No Java ${major} download is available for Windows right now.`);
  if (!/^[A-Za-z0-9._+-]+\.zip$/.test(zip.name)) throw new Error("Java returned an invalid archive filename.");
  const archive = path.join(home, zip.name);
  await download(zip.link, archive, { sha256: zip.checksum, onProgress });
  const staging = path.join(home, `.install-${randomUUID()}`);
  await mkdir(staging);
  try {
    const limits = { maxEntries: 10000, maxTotalBytes: 1024 ** 3 };
    const listing = await listArchive(archive, limits);
    if (listing.skipped) throw new Error("The Java archive contains unsupported links.");
    for (const entry of listing.entries) {
      if (entry.path.split("/").some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error("The Java archive contains an invalid Windows filename.");
    }
    await extractArchive(archive, staging, { limits, freeSpaceMargin: 128 * 1024 ** 2 });
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (entry.isDirectory()) await rename(path.join(staging, entry.name), path.join(home, `${entry.name}-${randomUUID().slice(0, 8)}`));
    }
  } finally { await rm(staging, { recursive: true, force: true }); await rm(archive, { force: true }); }
  const java = await findJava(home);
  if (!java) throw new Error("Java was downloaded but couldn't be found. Delete the runtime folder and try again.");
  return java;
}

const javaInstalls = new Map<number, Promise<string>>();
export function ensureJava(major: number, onProgress: (fraction: number) => void) {
  const existing = javaInstalls.get(major);
  if (existing) return existing;
  const work = installJava(major, onProgress).finally(() => javaInstalls.delete(major));
  javaInstalls.set(major, work);
  return work;
}
