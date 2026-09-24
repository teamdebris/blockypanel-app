import "server-only";

import { randomBytes } from "node:crypto";
import { currentActor, runAsActor } from "@/lib/actor";
import { accounts } from "@/lib/auth";
import { adoptRestoredServer, listServers, restoreServerFiles, serverSettingsForOffsite } from "@/lib/docker";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { localRepository, writeLocalRepositoryPassword } from "@/lib/incremental-backups";
import { notify } from "@/lib/notify";
import { describeDestination, folderPathProblem, type OffsiteDestination, type OffsiteIndex, passphraseProblem } from "@/lib/offsite-core";
import {
  addKey, copyServer, createLocalFromOffsite, currentKeyId, listWorldSnapshots, pruneRepository, readIndex, readSettingsSnapshot,
  removeKey, repositoryExists, ResticError, restoreWorld, WRONG_PASSWORD, writeIndex, writeSettingsSnapshot,
} from "@/lib/offsite-restic";
import { offsiteSettings, type OffsiteSchedule, type OffsiteSettings, offsiteStatus, panelId, resetOffsiteStatus, saveOffsiteSettings, updateOffsiteStatus } from "@/lib/offsite-settings";
import { generateSshKeyPair, hostKeyFingerprints, scanHostKey, targetFor } from "@/lib/offsite-targets";
import { assertServerId, DOCKER_STORAGE_ROOT, isServerId } from "@/lib/paths";
import { serialized } from "@/lib/rate-limit";
import { getServerControl, recordEvent } from "@/lib/store";

/**
 * Offsite backups, set up entirely from the panel. See lib/offsite-core.ts for the layout at the
 * destination. The panel stores the destination (with its secrets) and a random key to the index;
 * the owner's passphrase is a second key to the index and is never stored.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 7 * DAY_MS;
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 60_000;
const SSH_KEY = "offsite-ssh-key";
const isDemo = () => process.env.BLOCKY_DEMO === "true";

type RestoreItem = { id: string; name: string; state: "waiting" | "restoring" | "done" | "failed"; message?: string };
type RestoreJob = { startedAt: string; finishedAt?: string; servers: RestoreItem[]; message?: string };
type Jobs = { copying?: Promise<void>; restore?: RestoreJob };
const jobs = (globalThis as typeof globalThis & { __blockyOffsite?: Jobs }).__blockyOffsite ??= {};

function describe(error: unknown, fallback = "Unknown error.") {
  return error instanceof Error ? error.message : fallback;
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

// ---- Destinations from the form ----

type DestinationInput = OffsiteDestination;

async function storedSshKey() {
  return (await accounts()).getSetting<{ privateKey: string; publicKey: string }>(SSH_KEY);
}

/** A key pair for SFTP; the same one is returned until a new one is asked for. */
export async function sshPublicKey(regenerate = false) {
  if (isDemo()) return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyOnlyForTheDemoPanel0000000000000 blocky-panel";
  const existing = await storedSshKey();
  if (existing && !regenerate) return existing.publicKey;
  const pair = await generateSshKeyPair();
  (await accounts()).setSetting(SSH_KEY, pair);
  return pair.publicKey;
}

/**
 * Fills in secrets the form left blank (they're never sent to the browser) from the saved
 * destination, and the SSH key from the generated pair. Throws when a needed secret is missing.
 */
async function completeDestination(input: DestinationInput, previous?: OffsiteDestination): Promise<OffsiteDestination> {
  if (input.kind === "s3") {
    const secretAccessKey = input.secretAccessKey || (previous?.kind === "s3" && previous.accessKeyId === input.accessKeyId ? previous.secretAccessKey : undefined);
    if (!secretAccessKey) throw new BadRequestError("Enter the secret access key.", "secretAccessKey");
    if (["r2", "minio", "other"].includes(input.provider) && !input.endpoint) throw new BadRequestError("Enter the endpoint.", "endpoint");
    if (["b2", "wasabi", "aws"].includes(input.provider) && !input.region) throw new BadRequestError("Enter the region.", "region");
    return { ...input, secretAccessKey };
  }
  if (input.kind === "folder") {
    const problem = folderPathProblem(input.path, DOCKER_STORAGE_ROOT);
    if (problem && !/^[A-Za-z]:[\\/]/.test(input.path)) throw new BadRequestError(problem, "path");
    return input;
  }
  const sameServer = previous?.kind === "sftp" && previous.host === input.host && previous.port === input.port && previous.user === input.user ? previous : undefined;
  const hostKey = input.hostKey || sameServer?.hostKey;
  const destination: OffsiteDestination = { ...input, hostKey, hostFingerprints: hostKey ? await hostKeyFingerprints(hostKey) : undefined };
  if (input.auth === "password") {
    destination.password = input.password || sameServer?.password;
    if (!destination.password) throw new BadRequestError("Enter the password.", "password");
  } else {
    const key = await storedSshKey();
    if (!key && !sameServer?.privateKey) throw new BadRequestError("Generate an SSH key and add it to the server first.");
    destination.privateKey = key?.privateKey || sameServer?.privateKey;
    destination.publicKey = key?.publicKey || sameServer?.publicKey;
  }
  return destination;
}

/** The destination as the browser may see it: no secrets, only whether they're set. */
function publicDestination(destination: OffsiteDestination) {
  if (destination.kind === "s3") return { ...destination, secretAccessKey: undefined, hasSecret: Boolean(destination.secretAccessKey) };
  if (destination.kind === "sftp") return { ...destination, password: undefined, privateKey: undefined, hostKey: undefined, hasPassword: Boolean(destination.password) };
  return destination;
}

/** A readable error for a failed restic run against the destination. */
function destinationError(error: unknown) {
  const message = describe(error);
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) return new BadRequestError("The server's SSH host key doesn't match the one saved. If it was reinstalled, test the connection again to trust its new key.");
  if (/Permission denied|authentication failed/i.test(message)) return new BadRequestError("The destination refused the login. Check the user name and password or key.");
  if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403 Forbidden/i.test(message)) return new BadRequestError("The storage provider refused the keys. Check the access key, secret, and that they can read and write the bucket.");
  if (/NoSuchBucket|bucket does not exist/i.test(message)) return new BadRequestError("That bucket doesn't exist. Create it at your provider first.", "bucket");
  if (error instanceof BadRequestError) return error;
  return new BadRequestError(`Couldn't use the destination: ${message}`);
}

/** Whether the passphrase is wrong (restic finds no key it opens), as opposed to any other failure. */
function wrongPassword(error: unknown) {
  return error instanceof ResticError && (error.code === WRONG_PASSWORD || /wrong password|no key found/i.test(error.message));
}

/**
 * Runs a passphrase check. Checks run one at a time and a wrong passphrase costs two seconds, so the
 * passphrase can't be guessed quickly through the panel.
 */
function withPassphrase<T>(work: () => Promise<T>) {
  return serialized("offsite-passphrase", async () => {
    try { return await work(); }
    catch (error) {
      if (!wrongPassword(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      throw new BadRequestError("That passphrase doesn't open the backups at this destination.", "passphrase");
    }
  });
}

// ---- Overview ----

export async function offsiteOverview() {
  const [settings, status] = await Promise.all([offsiteSettings(), offsiteStatus()]);
  const key = isDemo() ? undefined : await storedSshKey();
  return {
    configured: Boolean(settings),
    ...(settings ? {
      destination: publicDestination(settings.destination),
      label: describeDestination(settings.destination),
      schedule: settings.schedule,
      keep: settings.keep,
      configuredAt: settings.configuredAt,
    } : {}),
    status: { ...status, copying: Boolean(jobs.copying) },
    restore: jobs.restore,
    sshPublicKey: isDemo() ? await sshPublicKey() : key?.publicKey,
  };
}

// ---- Setup ----

/**
 * Checks that the destination can be reached with these details, and whether Blocky backups are
 * already stored there. For SFTP without a pinned host key, returns the server's key to confirm.
 */
export async function testDestination(input: DestinationInput) {
  const previous = (await offsiteSettings())?.destination;
  if (input.kind === "sftp" && !input.hostKey && !(previous?.kind === "sftp" && previous.host === input.host && previous.port === input.port && previous.hostKey)) {
    if (isDemo()) return { needsHostKey: true, hostKey: "demo.local ssh-ed25519 AAAAdemo", fingerprints: ["ED25519 SHA256:Rk3Lx0DemoFingerprintOnlyForTheDemoPanel0000"] };
    return { needsHostKey: true, ...(await scanHostKey(input.host, input.port)) };
  }
  const destination = await completeDestination(input, previous);
  if (isDemo()) return { ok: true, existing: false, message: "Connected. Nothing is stored here yet." };
  const target = await targetFor(destination);
  try {
    const existing = await repositoryExists(target.runner, target.index, "blocky-connection-test", AbortSignal.timeout(TEST_TIMEOUT_MS));
    return { ok: true, existing, message: existing ? "Connected. Blocky backups are already stored here; your passphrase will open them." : "Connected. Nothing is stored here yet." };
  } catch (error) { throw destinationError(error); }
}

/**
 * Sets up (or moves) offsite backups. An empty destination gets a new index, opened by a random key
 * the panel keeps and by the passphrase. A destination that already holds Blocky backups (this
 * panel's before a reinstall, or another panel's) is joined with its passphrase.
 */
export async function configureOffsite(input: { destination: DestinationInput; passphrase: string; schedule: OffsiteSchedule; keep: number }) {
  const problem = passphraseProblem(input.passphrase);
  if (problem) throw new BadRequestError(problem, "passphrase");
  if (jobs.copying) throw new ConflictError("An offsite copy is running. Try again when it finishes.");
  const previous = await offsiteSettings();
  const destination = await completeDestination(input.destination, previous?.destination);
  const indexPassword = newSecret();
  let panelKeyId = "demo";
  let passphraseKeyId = "demo";
  if (!isDemo()) {
    const target = await targetFor(destination);
    let existing: boolean;
    try { existing = await repositoryExists(target.runner, target.index, indexPassword); }
    catch (error) { throw destinationError(error); }
    if (existing) {
      await withPassphrase(() => readIndex(target.runner, target.index, input.passphrase));
      passphraseKeyId = await currentKeyId(target.runner, target.index, input.passphrase);
      panelKeyId = await addKey(target.runner, target.index, input.passphrase, indexPassword);
      // Reconnecting to the same place: the old panel key is no longer needed.
      if (previous && describeDestination(previous.destination) === describeDestination(destination) && previous.panelKeyId !== panelKeyId) {
        await removeKey(target.runner, target.index, indexPassword, previous.panelKeyId).catch(() => undefined);
      }
    } else {
      try {
        await target.runner.run(["init"], { repository: target.index, password: indexPassword });
        panelKeyId = await currentKeyId(target.runner, target.index, indexPassword);
        passphraseKeyId = await addKey(target.runner, target.index, indexPassword, input.passphrase);
        await writeIndex(target.runner, target.index, indexPassword, { version: 1, panelId: await panelId(), updatedAt: new Date().toISOString(), servers: {} });
      } catch (error) { throw destinationError(error); }
    }
  }
  await saveOffsiteSettings({ destination, schedule: input.schedule, keep: input.keep, indexPassword, panelKeyId, passphraseKeyId, configuredAt: new Date().toISOString() });
  await resetOffsiteStatus();
  (await accounts()).audit(await currentActor() || "Admin", `Set up offsite backups to ${describeDestination(destination)}`);
  await startCopy();
  return offsiteOverview();
}

/** Changes how often copies run, how many are kept, or the passphrase (only the index is re-keyed). */
export async function updateOffsite(input: { schedule?: OffsiteSchedule; keep?: number; passphrase?: string }) {
  const settings = await offsiteSettings();
  if (!settings) throw new NotFoundError("Offsite backups aren't set up.");
  const next: OffsiteSettings = { ...settings, schedule: input.schedule ?? settings.schedule, keep: input.keep ?? settings.keep };
  if (input.passphrase !== undefined) {
    const problem = passphraseProblem(input.passphrase);
    if (problem) throw new BadRequestError(problem, "passphrase");
    if (!isDemo()) {
      const target = await targetFor(settings.destination);
      try {
        next.passphraseKeyId = await addKey(target.runner, target.index, settings.indexPassword, input.passphrase);
        await removeKey(target.runner, target.index, settings.indexPassword, settings.passphraseKeyId);
      } catch (error) { throw destinationError(error); }
    }
    (await accounts()).audit(await currentActor() || "Admin", "Changed the offsite backup passphrase");
  }
  await saveOffsiteSettings(next);
  return offsiteOverview();
}

/** Stops copying. What's already at the destination stays there. */
export async function disableOffsite() {
  const settings = await offsiteSettings();
  if (!settings) return;
  if (jobs.copying) throw new ConflictError("An offsite copy is running. Try again when it finishes.");
  await saveOffsiteSettings(undefined);
  await resetOffsiteStatus();
  (await accounts()).audit(await currentActor() || "Admin", `Turned off offsite backups to ${describeDestination(settings.destination)}`);
}

// ---- Copying ----

async function copyAll() {
  const settings = await offsiteSettings();
  if (!settings) return;
  const startedAt = new Date().toISOString();
  const servers = await listServers().catch(() => []);
  if (isDemo()) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await updateOffsiteStatus((status) => {
      Object.assign(status, { lastRunAt: startedAt, lastSuccessAt: startedAt, lastError: undefined });
      for (const server of servers) status.servers[server.id] = { lastCopyAt: startedAt };
    });
    return;
  }
  let index: OffsiteIndex;
  let target: Awaited<ReturnType<typeof targetFor>>;
  try {
    target = await targetFor(settings.destination);
    index = await readIndex(target.runner, target.index, settings.indexPassword);
  } catch (error) {
    const message = destinationError(error).message;
    await updateOffsiteStatus((status) => { status.lastRunAt = startedAt; status.lastError = message; });
    void notify(`Offsite backup failed: ${message}`);
    return;
  }
  const writer = await panelId();
  const writeIndexNow = () => { index.updatedAt = new Date().toISOString(); index.panelId = writer; return writeIndex(target.runner, target.index, settings.indexPassword, index); };
  let failures = 0;
  const current = new Set<string>();
  for (const server of servers) {
    if (!isServerId(server.id) || server.operation?.kind === "create") continue;
    current.add(server.id);
    const local = await localRepository(server.id).catch(() => undefined);
    if (!local) continue;
    const repository = target.server(server.id);
    try {
      // The index learns a server's password before anything of it is copied, so a copy is never
      // stranded without its key.
      if (index.servers[server.id]?.repositoryPassword !== local.password) {
        index.servers[server.id] = { name: server.name, type: server.type, version: server.version, repositoryPassword: local.password, lastCopyAt: index.servers[server.id]?.lastCopyAt || "" };
        await writeIndexNow();
      }
      const retention = (await getServerControl(server.id)).backupPolicy.retention;
      await copyServer(target.runner, { serverId: server.id, repository, password: local.password, keep: Math.max(settings.keep, retention) });
      await writeSettingsSnapshot(target.runner, repository, local.password, await serverSettingsForOffsite(server.id));
      const previous = (await offsiteStatus()).servers[server.id];
      let lastPruneAt = previous?.lastPruneAt;
      if (!lastPruneAt || Date.now() - Date.parse(lastPruneAt) > PRUNE_EVERY_MS) {
        await pruneRepository(target.runner, repository, local.password).catch(() => undefined);
        lastPruneAt = new Date().toISOString();
      }
      const copiedAt = new Date().toISOString();
      index.servers[server.id] = { name: server.name, type: server.type, version: server.version, repositoryPassword: local.password, lastCopyAt: copiedAt };
      await updateOffsiteStatus((status) => { status.servers[server.id] = { lastCopyAt: copiedAt, lastPruneAt }; });
      if (previous?.lastError) await recordEvent(server.id, "backup-offsite", "Offsite copies are working again.", "success");
    } catch (error) {
      failures += 1;
      const message = destinationError(error).message;
      await updateOffsiteStatus((status) => { status.servers[server.id] = { ...status.servers[server.id], lastError: message }; });
      await recordEvent(server.id, "backup-offsite", `Offsite copy failed: ${message}`, "error");
    }
  }
  for (const [id, entry] of Object.entries(index.servers)) entry.removed = !current.has(id) || undefined;
  let indexError = "";
  await writeIndexNow().catch((error) => { indexError = destinationError(error).message; });
  await updateOffsiteStatus((status) => {
    status.lastRunAt = startedAt;
    if (!failures && !indexError) { status.lastSuccessAt = startedAt; status.lastError = undefined; }
    else status.lastError = indexError || `${failures} server${failures === 1 ? "" : "s"} couldn't be copied.`;
  });
  if (indexError) void notify(`Offsite backup index couldn't be updated: ${indexError}`);
}

/** Starts a copy of every server in the background, unless one is already running. */
export async function startCopy() {
  if (!(await offsiteSettings())) throw new NotFoundError("Offsite backups aren't set up.");
  if (!jobs.copying) {
    const actor = await currentActor();
    jobs.copying = runAsActor(actor, copyAll).catch((error) => console.error("Blocky offsite copy failed", error)).finally(() => { jobs.copying = undefined; });
  }
  return { message: "Copying to the offsite destination." };
}

/** Called every minute by the scheduler. */
export async function runOffsiteSchedule() {
  const settings = await offsiteSettings();
  if (!settings || jobs.copying || jobs.restore && !jobs.restore.finishedAt) return;
  const status = await offsiteStatus();
  const now = Date.now();
  const lastRun = status.lastRunAt ? Date.parse(status.lastRunAt) : 0;
  if (status.lastError && now - lastRun < RETRY_AFTER_FAILURE_MS) return;
  let due = false;
  if (settings.schedule === "daily") due = now - lastRun >= DAY_MS;
  else {
    for (const server of await listServers().catch(() => [])) {
      const lastBackup = server.backup?.lastRunAt ? Date.parse(server.backup.lastRunAt) : 0;
      const lastCopy = status.servers[server.id]?.lastCopyAt ? Date.parse(status.servers[server.id].lastCopyAt!) : 0;
      if (lastBackup > lastCopy) { due = true; break; }
    }
  }
  if (due) await startCopy();
}

// ---- A server's offsite snapshots ----

async function serverTarget(serverId: string) {
  assertServerId(serverId);
  const settings = await offsiteSettings();
  if (!settings) throw new NotFoundError("Offsite backups aren't set up.");
  const local = await localRepository(serverId);
  if (!local) throw new NotFoundError("This server has no backups yet.");
  const target = await targetFor(settings.destination);
  return { target, repository: target.server(serverId), password: local.password };
}

export async function listServerOffsiteSnapshots(serverId: string) {
  if (isDemo()) {
    const copiedAt = (await offsiteStatus()).servers[serverId]?.lastCopyAt;
    return copiedAt ? [{ id: "d".repeat(64), time: copiedAt, path: "/data", size: 2_483_212_800, kind: "scheduled" }] : [];
  }
  const { target, repository, password } = await serverTarget(serverId);
  try {
    if (!(await repositoryExists(target.runner, repository, password))) return [];
    return await listWorldSnapshots(target.runner, repository, password);
  } catch (error) { throw destinationError(error); }
}

/** Rolls a server back to one of its offsite snapshots (a safety backup is taken first). */
export async function restoreServerSnapshot(serverId: string, snapshotId: string) {
  if (isDemo()) throw new BadRequestError("Restoring requires a real Docker host.");
  const { target, repository, password } = await serverTarget(serverId);
  const snapshot = (await listWorldSnapshots(target.runner, repository, password).catch((error) => { throw destinationError(error); })).find((item) => item.id === snapshotId);
  if (!snapshot) throw new NotFoundError("That offsite snapshot no longer exists.");
  return restoreServerFiles(serverId, "Restoring an offsite backup", () => restoreWorld(target.runner, { serverId, repository, password, snapshotId: snapshot.id, path: snapshot.path }), "Offsite backup restored and health check passed.");
}

// ---- Disaster recovery ----

async function openIndexWithPassphrase(input: { destination: DestinationInput; passphrase: string }) {
  const destination = await completeDestination(input.destination, (await offsiteSettings())?.destination);
  const target = await targetFor(destination);
  let exists: boolean;
  try { exists = await repositoryExists(target.runner, target.index, input.passphrase); }
  catch (error) { throw destinationError(error); }
  if (!exists) throw new BadRequestError("No Blocky backups were found at this destination. Check the bucket, prefix, or folder.");
  const index = await withPassphrase(() => readIndex(target.runner, target.index, input.passphrase));
  return { destination, target, index };
}

/** The servers stored at a destination, opened with the passphrase. */
export async function discoverOffsite(input: { destination: DestinationInput; passphrase: string }) {
  const here = new Set((await listServers().catch(() => [])).map((server) => server.id));
  if (isDemo()) {
    return { servers: [{ id: "d3m0-archive-0001", name: "Old Survival World", type: "PAPER", version: "1.21.8", lastCopyAt: new Date(Date.now() - 3 * DAY_MS).toISOString(), removed: true, here: false }] };
  }
  const { index } = await openIndexWithPassphrase(input);
  return {
    servers: Object.entries(index.servers)
      .map(([id, entry]) => ({ id, name: entry.name, type: entry.type, version: entry.version, lastCopyAt: entry.lastCopyAt, removed: Boolean(entry.removed), here: here.has(id) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function restoreOne(target: Awaited<ReturnType<typeof targetFor>>, id: string, password: string) {
  const repository = target.server(id);
  const settings = await readSettingsSnapshot(target.runner, repository, password).catch(() => { throw new Error("Its settings weren't found at the destination."); });
  const [snapshot] = await listWorldSnapshots(target.runner, repository, password);
  if (!snapshot) throw new Error("No world snapshots were found for it.");
  await adoptRestoredServer(id, settings, async () => {
    await restoreWorld(target.runner, { serverId: id, repository, password, snapshotId: snapshot.id, path: snapshot.path });
    await writeLocalRepositoryPassword(id, password);
    await createLocalFromOffsite(target.runner, { serverId: id, repository, password });
  });
}

/**
 * Recreates servers from the destination with their settings and newest world, one at a time in
 * the background. Afterwards, if this panel had no offsite destination, it adopts this one.
 */
export async function restoreFromOffsite(input: { destination: DestinationInput; passphrase: string; servers: string[] }) {
  if (isDemo()) throw new BadRequestError("Restoring requires a real Docker host.");
  if (jobs.restore && !jobs.restore.finishedAt) throw new ConflictError("A restore is already running.");
  if (jobs.copying) throw new ConflictError("An offsite copy is running. Try again when it finishes.");
  const { destination, target, index } = await openIndexWithPassphrase(input);
  const chosen = [...new Set(input.servers)].filter((id) => index.servers[id]);
  if (!chosen.length) throw new BadRequestError("None of those servers are stored at this destination.");
  const job: RestoreJob = { startedAt: new Date().toISOString(), servers: chosen.map((id) => ({ id, name: index.servers[id].name, state: "waiting" })) };
  jobs.restore = job;
  const actor = await currentActor();
  void runAsActor(actor, async () => {
    for (const item of job.servers) {
      item.state = "restoring";
      try { await restoreOne(target, item.id, index.servers[item.id].repositoryPassword); item.state = "done"; }
      catch (error) { item.state = "failed"; item.message = describe(error); }
    }
    try {
      if (!(await offsiteSettings())) {
        const indexPassword = newSecret();
        const passphraseKeyId = await currentKeyId(target.runner, target.index, input.passphrase);
        const panelKeyId = await addKey(target.runner, target.index, input.passphrase, indexPassword);
        await saveOffsiteSettings({ destination, schedule: "after-backup", keep: 30, indexPassword, panelKeyId, passphraseKeyId, configuredAt: new Date().toISOString() });
        job.message = "This panel now copies its backups to the same destination.";
      }
    } catch (error) { job.message = `The servers were restored, but offsite backups couldn't be turned on here: ${describe(error)}`; }
    job.finishedAt = new Date().toISOString();
    (await accounts()).audit(actor || "Admin", `Restored ${job.servers.filter((item) => item.state === "done").length} of ${job.servers.length} servers from ${describeDestination(destination)}`);
  });
  return { message: `Restoring ${chosen.length} server${chosen.length === 1 ? "" : "s"}.`, restore: job };
}
