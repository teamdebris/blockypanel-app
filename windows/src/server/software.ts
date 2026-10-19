import { access, mkdir, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { download, getJson } from "./download";
import { RUNTIME_DIR } from "./paths";
import type { Software } from "./store";

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
  if (software === "vanilla") return (await mojang()).versions.filter((item) => item.type === "release").map((item) => item.id).slice(0, 40);
  const project = await getJson<{ versions: Record<string, string[]> }>("https://fill.papermc.io/v3/projects/paper");
  return Object.values(project.versions).flat().filter((version) => RELEASE.test(version)).slice(0, 40);
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
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

/** java.exe for `major`, downloading Eclipse Temurin (a free OpenJDK build) the first time. */
export async function ensureJava(major: number, onProgress: (fraction: number) => void) {
  const home = javaHome(major);
  const existing = await findJava(home);
  if (existing) return existing;
  type Asset = { binary: { package: { name: string; link: string; checksum: string } } };
  const assets = await getJson<Asset[]>(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`);
  const zip = assets.map((asset) => asset.binary.package).find((item) => item.name.endsWith(".zip"));
  if (!zip) throw new Error(`No Java ${major} download is available for Windows right now.`);
  await mkdir(home, { recursive: true });
  const archive = path.join(home, zip.name);
  await download(zip.link, archive, { sha256: zip.checksum, onProgress });
  // Windows ships an unzipper in PowerShell; no extra tools needed.
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${home.replace(/'/g, "''")}' -Force`], { windowsHide: true });
  await rm(archive, { force: true });
  const java = await findJava(home);
  if (!java) throw new Error("Java was downloaded but couldn't be found. Delete the runtime folder and try again.");
  return java;
}
