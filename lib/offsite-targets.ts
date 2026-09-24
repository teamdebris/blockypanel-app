import "server-only";

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { BadRequestError } from "@/lib/errors";
import { repositoryFor, scrubSecrets, secretsOf, type OffsiteDestination } from "@/lib/offsite-core";
import { directRunner, ResticError, type RunOptions, type Runner } from "@/lib/offsite-restic";
import { DOCKER_STORAGE_ROOT, PANEL_ROOT, resticCachePath, serverBackupPath, serverDataPath, STORAGE_ROOT, storagePath } from "@/lib/paths";

/**
 * Where restic runs for each kind of destination. S3 and SFTP run restic in the panel. A folder on
 * this machine isn't visible inside the panel's container, so restic runs in a short-lived helper
 * container that mounts it; no Compose change is needed. Outside a container (development), restic
 * runs directly.
 */

export type Target = { runner: Runner; index: string; server: (id: string) => string };

const HELPER_IMAGE = "restic/restic:0.19.1";
const HELPER_FOLDER = "/dest";
const docker = new Docker();

const localPaths = {
  localRepository: (id: string) => storagePath(serverBackupPath(id), "restic"),
  dataFolder: (id: string) => serverDataPath(id),
};

function inContainer() {
  return existsSync("/.dockerenv");
}

function sshFolder() {
  return storagePath(PANEL_ROOT, "offsite", "ssh");
}

/** Removes secrets from every error message a runner produces. */
function scrubbed(runner: Runner, secrets: string[]): Runner {
  return {
    ...runner,
    run: (args, options) => runner.run(args, options).catch((error: unknown) => {
      if (error instanceof ResticError) throw new ResticError(scrubSecrets(error.message, secrets), error.code);
      if (error instanceof Error) error.message = scrubSecrets(error.message, secrets);
      throw error;
    }),
  };
}

async function ensureHelperImage() {
  try { await docker.getImage(HELPER_IMAGE).inspect(); return; } catch { /* not pulled yet */ }
  const stream = await docker.pull(HELPER_IMAGE);
  await new Promise<void>((resolve, reject) => docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve()));
}

function friendlyDockerError(error: unknown, hostFolder: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (/bind source path does not exist/i.test(message)) return new BadRequestError(`The folder ${hostFolder} doesn't exist on this machine. Create it (or mount the disk) first.`, "path");
  return error instanceof Error ? error : new Error(message);
}

/**
 * Runs restic in a helper container: the panel's storage is mounted at the same path it has in the
 * panel (so local repositories and data folders resolve the same way) and the destination folder at
 * /dest. No network, no new privileges. Standard input goes through a short-lived file in the
 * panel's storage, read by the container's shell.
 */
function helperRunner(hostFolder: string): Runner {
  return {
    ...localPaths,
    async run(args, run: RunOptions) {
      await ensureHelperImage();
      const inputFile = run.stdin === undefined ? undefined : storagePath(PANEL_ROOT, "cache", `offsite-input-${randomUUID()}`);
      if (inputFile) { await mkdir(storagePath(PANEL_ROOT, "cache"), { recursive: true, mode: 0o700 }); await writeFile(inputFile, run.stdin!, { mode: 0o600 }); }
      const env = [
        `RESTIC_REPOSITORY=${run.repository}`, `RESTIC_PASSWORD=${run.password}`, `RESTIC_CACHE_DIR=${resticCachePath()}`,
        ...(run.from ? [`RESTIC_FROM_REPOSITORY=${run.from.repository}`, `RESTIC_FROM_PASSWORD=${run.from.password}`] : []),
        ...(inputFile ? [`BLOCKY_INPUT=${inputFile}`] : []),
      ];
      let container: Docker.Container | undefined;
      try {
        container = await docker.createContainer({
          Image: HELPER_IMAGE,
          ...(inputFile ? { Entrypoint: ["/bin/sh", "-c", "exec restic \"$@\" < \"$BLOCKY_INPUT\"", "restic"] } : {}),
          Cmd: ["--retry-lock", "1m", ...args],
          Env: env,
          Labels: { "panel.helper": "offsite" },
          AttachStdout: true, AttachStderr: true, Tty: false,
          HostConfig: {
            NetworkMode: "none",
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 1024 ** 3,
            Mounts: [
              { Type: "bind", Source: DOCKER_STORAGE_ROOT, Target: STORAGE_ROOT },
              { Type: "bind", Source: hostFolder, Target: HELPER_FOLDER },
            ],
          },
        });
        const stream = await container.attach({ stream: true, stdout: true, stderr: true });
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let output = "";
        let errors = "";
        stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-8192); });
        container.modem.demuxStream(stream, stdout, stderr);
        const ended = once(stream, "end").catch(() => undefined);
        const abort = () => void container?.kill().catch(() => undefined);
        run.signal?.addEventListener("abort", abort, { once: true });
        try {
          await container.start();
          const result = await container.wait() as { StatusCode: number };
          await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))]);
          if (run.signal?.aborted) throw new Error("The destination didn't answer in time.");
          if (result.StatusCode !== 0) throw new ResticError(errors.trim().split("\n").filter((line) => !line.startsWith("Is there a repository")).join(" ").trim() || `restic exited with ${result.StatusCode}`, result.StatusCode);
          return output;
        } finally { run.signal?.removeEventListener("abort", abort); }
      } catch (error) {
        throw error instanceof ResticError ? error : friendlyDockerError(error, hostFolder);
      } finally {
        await container?.remove({ force: true }).catch(() => undefined);
        if (inputFile) await rm(inputFile, { force: true });
      }
    },
  };
}

// ---- SSH ----

function run(command: string, args: string[], options: { stdin?: string; timeoutMs?: number } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on("error", (error) => reject(error.name === "AbortError" ? new Error(`${command} took too long.`) : new Error(`Could not run ${command}: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

/** The server's host keys and their fingerprints, for pinning on first use. */
export async function scanHostKey(host: string, port: number) {
  const output = await run("ssh-keyscan", ["-T", "10", "-p", String(port), "--", host]).catch(() => "");
  const hostKey = output.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).join("\n");
  if (!hostKey) throw new BadRequestError(`Couldn't reach an SSH server at ${host}:${port}. Check the host and port.`, "host");
  return { hostKey, fingerprints: await hostKeyFingerprints(hostKey) };
}

export async function hostKeyFingerprints(hostKey: string) {
  const output = await run("ssh-keygen", ["-l", "-f", "-"], { stdin: `${hostKey}\n` }).catch(() => "");
  // "256 SHA256:abc... host (ED25519)" -> "ED25519 SHA256:abc..."
  return output.split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2).map((parts) => `${(parts.at(-1) || "").replace(/[()]/g, "")} ${parts[1]}`.trim());
}

/** A new SSH key pair for SFTP destinations. The private key is kept in panel.db like other secrets. */
export async function generateSshKeyPair() {
  const folder = storagePath(PANEL_ROOT, "cache", `ssh-${randomUUID()}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    const file = storagePath(folder, "key");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "blocky-panel", "-f", file]);
    return { privateKey: await readFile(file, "utf8"), publicKey: (await readFile(`${file}.pub`, "utf8")).trim() };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function sftpRunner(destination: Extract<OffsiteDestination, { kind: "sftp" }>): Promise<Runner> {
  if (!destination.hostKey) throw new BadRequestError("Test the connection first, to confirm the server's host key.");
  const folder = sshFolder();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(`${destination.host}:${destination.port}`).digest("hex").slice(0, 16);
  const knownHosts = storagePath(folder, `known_hosts-${name}`);
  await writeFile(knownHosts, `${destination.hostKey}\n`, { mode: 0o600 });
  const ssh = ["ssh", "-p", String(destination.port), "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30"];
  let command: string[];
  if (destination.auth === "key") {
    if (!destination.privateKey) throw new BadRequestError("Generate an SSH key first.");
    const keyFile = storagePath(folder, `key-${name}`);
    await writeFile(keyFile, destination.privateKey.endsWith("\n") ? destination.privateKey : `${destination.privateKey}\n`, { mode: 0o600 });
    command = [...ssh, "-i", keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no"];
  } else {
    if (!destination.password) throw new BadRequestError("Enter the password.", "password");
    command = ["sshpass", "-e", ...ssh, "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive"];
  }
  command.push(`${destination.user}@${destination.host}`, "-s", "sftp");
  return directRunner({
    ...localPaths,
    cacheDir: resticCachePath(),
    args: ["-o", `sftp.command=${command.join(" ")}`],
    env: destination.auth === "password" ? { SSHPASS: destination.password! } : {},
  });
}

// ---- Targets ----

export async function targetFor(destination: OffsiteDestination): Promise<Target> {
  let runner: Runner;
  let folderRoot: string | undefined;
  if (destination.kind === "s3") {
    runner = directRunner({
      ...localPaths,
      cacheDir: resticCachePath(),
      env: { AWS_ACCESS_KEY_ID: destination.accessKeyId, AWS_SECRET_ACCESS_KEY: destination.secretAccessKey || "", AWS_DEFAULT_REGION: destination.region || "us-east-1" },
    });
  } else if (destination.kind === "sftp") {
    runner = await sftpRunner(destination);
  } else if (inContainer()) {
    runner = helperRunner(destination.path);
    folderRoot = HELPER_FOLDER;
  } else {
    if (!existsSync(destination.path)) throw new BadRequestError(`The folder ${destination.path} doesn't exist. Create it (or mount the disk) first.`, "path");
    runner = directRunner({ ...localPaths, cacheDir: resticCachePath() });
  }
  await mkdir(resticCachePath(), { recursive: true, mode: 0o700 });
  return {
    runner: scrubbed(runner, secretsOf(destination)),
    index: repositoryFor(destination, "index", folderRoot),
    server: (id) => repositoryFor(destination, { server: id }, folderRoot),
  };
}
