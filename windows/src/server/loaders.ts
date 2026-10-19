import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { download, getJson } from "./download";
import { serverDir } from "./paths";
import type { Software } from "./store";

type InstallerType = "quilt" | "forge" | "neoforge";
type Marker = { software: InstallerType; minecraft: string; loader: string };
type Spec = Marker & { url: string; sha256?: string; sha1?: string; installArgs: string[] };
const PLAIN = /^\d+(\.\d+)+$/;
const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const FORGE = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEO = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

export function neoMinecraftVersion(loader: string) {
  if (!PLAIN.test(loader)) return undefined;
  const [major, minor, patch] = loader.split(".").map(Number);
  if (major >= 26 && patch !== undefined) return `${major}.${minor}${patch ? `.${patch}` : ""}`;
  if (major >= 20 && major <= 21) return `1.${major}${minor ? `.${minor}` : ""}`;
  return undefined;
}

export async function loaderVersions(software: InstallerType): Promise<string[]> {
  if (software === "quilt") {
    const list = await getJson<{ version: string; stable: boolean }[]>("https://meta.quiltmc.org/v3/versions/game");
    return list.filter((entry) => entry.stable && PLAIN.test(entry.version)).map((entry) => entry.version);
  }
  if (software === "forge") {
    const list = await getJson<{ promos: Record<string, string> }>(FORGE);
    return sorted(Object.keys(list.promos).map((key) => key.replace(/-(recommended|latest)$/, "")).filter((version) => PLAIN.test(version)));
  }
  const list = await getJson<{ versions: string[] }>(NEO);
  return sorted(list.versions.map(neoMinecraftVersion).filter((value): value is string => !!value));
}

async function checksum(url: string, algorithm: "sha256" | "sha1") {
  const response = await fetch(`${url}.${algorithm}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Could not verify the installer checksum (${response.status}).`);
  const value = (await response.text()).trim().split(/\s+/)[0];
  if (!(algorithm === "sha256" ? /^[a-f0-9]{64}$/i : /^[a-f0-9]{40}$/i).test(value)) throw new Error("The installer service returned an invalid checksum.");
  return value.toLowerCase();
}

export async function installerSpec(software: InstallerType, minecraft: string): Promise<Spec> {
  if (!PLAIN.test(minecraft)) throw new Error("Choose a stable Minecraft release.");
  if (software === "quilt") {
    const loaders = await getJson<{ loader: { version: string } }[]>(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(minecraft)}`);
    const loader = sorted(loaders.map((entry) => entry.loader.version).filter((version) => PLAIN.test(version)))[0];
    const installers = await getJson<{ version: string; url: string; hashes: { sha256: string } }[]>("https://meta.quiltmc.org/v3/versions/installer");
    const installer = installers.filter((entry) => PLAIN.test(entry.version)).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (!loader || !installer) throw new Error(`No stable Quilt installer and loader were found for ${minecraft}.`);
    const url = new URL(installer.url);
    if (url.protocol !== "https:" || url.hostname !== "maven.quiltmc.org") throw new Error("Quilt returned an unexpected installer address.");
    // Quilt Meta can cache hashes for an older installer upload. Verify against the checksum
    // published alongside the actual installer on Quilt's Maven repository.
    return { software, minecraft, loader, url: installer.url, sha256: await checksum(installer.url, "sha256"), installArgs: ["install", "server", minecraft, loader, "--download-server", "--install-dir=."] };
  }
  let loader: string;
  let url: string;
  if (software === "forge") {
    const { promos } = await getJson<{ promos: Record<string, string> }>(FORGE);
    loader = promos[`${minecraft}-recommended`] || promos[`${minecraft}-latest`];
    if (!loader || !PLAIN.test(loader)) throw new Error(`Forge has no supported build for ${minecraft}.`);
    const version = `${minecraft}-${loader}`;
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
    return { software, minecraft, loader, url, sha1: await checksum(url, "sha1"), installArgs: ["--installServer"] };
  }
  const list = await getJson<{ versions: string[] }>(NEO);
  loader = sorted(list.versions.filter((version) => neoMinecraftVersion(version) === minecraft))[0];
  if (!loader) throw new Error(`NeoForge has no stable build for ${minecraft}.`);
  url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar`;
  return { software, minecraft, loader, url, sha256: await checksum(url, "sha256"), installArgs: ["--installServer"] };
}

async function launchArgs(marker: Marker, root: string): Promise<string[] | undefined> {
  if (!PLAIN.test(marker.minecraft) || !PLAIN.test(marker.loader)) return undefined;
  const candidates = marker.software === "quilt" ? ["quilt-server-launch.jar"]
    : marker.software === "forge" ? [`libraries/net/minecraftforge/forge/${marker.minecraft}-${marker.loader}/win_args.txt`, `forge-${marker.minecraft}-${marker.loader}.jar`]
      : [`libraries/net/neoforged/neoforge/${marker.loader}/win_args.txt`];
  for (const candidate of candidates) {
    try {
      const info = await lstat(path.join(root, candidate));
      if (!info.isFile() || info.isSymbolicLink()) continue;
      return candidate.endsWith(".txt") ? [`@${candidate}`, "nogui"] : ["-jar", candidate, "nogui"];
    } catch { /* not installed yet */ }
  }
  return undefined;
}

const installers = new Set<ChildProcessWithoutNullStreams>();
let closing = false;
export async function runInstaller(java: string, args: string[], cwd: string, onLine: (line: string) => void) {
  if (closing) throw new Error("The panel is shutting down.");
  const child = spawn(java, args, { cwd, windowsHide: true });
  installers.add(child);
  let tail = "";
  const log = (chunk: Buffer) => { const text = chunk.toString("utf8"); tail = (tail + text).slice(-8000); for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.slice(0, 8192)); };
  child.stdout.on("data", log); child.stderr.on("data", log);
  const timer = setTimeout(() => child.kill(), 15 * 60000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`The loader installer exited (${code}). ${tail.slice(-2000)}`)));
    });
  } finally { clearTimeout(timer); installers.delete(child); }
}
export function stopLoaderInstallers() { closing = true; for (const installer of installers) installer.kill(); }

export async function prepareLoader(software: Software, minecraft: string, id: string, java: string, onLine: (line: string) => void, onStep: (step: string) => void) {
  if (software !== "quilt" && software !== "forge" && software !== "neoforge") throw new Error("Unsupported installer type.");
  const root = serverDir(id);
  const markerFile = path.join(root, ".blocky-loader.json");
  const marker = await readFile(markerFile, "utf8").then((text) => JSON.parse(text) as Marker).catch(() => undefined);
  if (marker?.software === software && marker.minecraft === minecraft) {
    const ready = await launchArgs(marker, root);
    if (ready) return ready;
  }
  onStep(`Downloading ${software} installer`);
  const spec = await installerSpec(software, minecraft);
  const folder = path.join(root, ".blocky-installers");
  await mkdir(folder, { recursive: true });
  if ((await lstat(folder)).isSymbolicLink()) throw new Error("The installer folder cannot be a link or junction.");
  const file = path.join(folder, `${software}-${spec.loader}-installer.jar`);
  await download(spec.url, file, { sha256: spec.sha256, sha1: spec.sha1, allowedHosts: [new URL(spec.url).hostname] });
  onStep(`Installing ${software} ${spec.loader}`);
  await runInstaller(java, ["-jar", path.relative(root, file), ...spec.installArgs], root, onLine);
  const ready = await launchArgs(spec, root);
  if (!ready) throw new Error(`${software} finished installing but its Windows launch files were not found. Check the console for installer errors.`);
  const temporary = `${markerFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ software, minecraft, loader: spec.loader }));
  await rename(temporary, markerFile);
  return ready;
}
