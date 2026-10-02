import "server-only";

import { hostname } from "node:os";
import { currentActor } from "@/lib/actor";
import { accounts } from "@/lib/auth";
import {
  type BackupCredentials, type CheckinResponse, checkinServers, cloudAddresses, cloudPrefix, type CloudState, needsNewCredentials,
  nextCheckinDelay, normalizeConsoleUrl, parseCheckin, parseCredentials, versionAtLeast,
} from "@/lib/cloud-core";
import { listServers } from "@/lib/docker";
import { BadRequestError, ConflictError } from "@/lib/errors";
import type { OffsiteDestination } from "@/lib/offsite-core";
import { panelId } from "@/lib/offsite-settings";
import { panelVersion } from "@/lib/version";

/**
 * Blocky Cloud: linking this panel to an account on the console, checking in every five minutes so
 * its blockylink.net name follows this machine's address, and fetching Blocky Cloud backup keys.
 * The console's side is a separate project; docs/console-api.md is the contract between them.
 */

const STATE = "cloud";
const REQUEST_TIMEOUT_MS = 15_000;
const isDemo = () => process.env.BLOCKY_DEMO === "true";
const disabled = () => process.env.BLOCKY_CLOUD === "false" || isDemo();

type Linking = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: number; interval: number; error?: string; timer?: NodeJS.Timeout; actor: string };
type Runtime = { linking?: Linking; checkingIn?: Promise<void> };
const runtime = (globalThis as typeof globalThis & { __blockyCloud?: Runtime }).__blockyCloud ??= {};

export class ConsoleError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

function consoleUrl() {
  return normalizeConsoleUrl(process.env.BLOCKY_CLOUD_URL);
}

async function loadState(): Promise<CloudState> {
  const saved = (await accounts()).getSetting<CloudState>(STATE);
  return saved ?? { consoleUrl: consoleUrl(), failures: 0 };
}

async function saveState(state: CloudState | undefined) {
  (await accounts()).setSetting(STATE, state);
}

/** Read-modify-write; the store is synchronous, so nothing interleaves between the read and the write. */
async function updateState(change: (state: CloudState) => void) {
  const state = await loadState();
  change(state);
  await saveState(state);
  return state;
}

function panelName() {
  return (process.env.BLOCKY_PANEL_NAME || hostname() || "Blocky Panel").slice(0, 100);
}

/** One call to the console. Errors carry the console's own message when it sent one. */
async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: T }> {
  let response: Response;
  try {
    response = await fetch(`${consoleUrl()}/v1${path}`, {
      method: init.method || "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": `BlockyPanel/${panelVersion().version}`,
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "it didn't answer in time" : "it couldn't be reached";
    throw new ConsoleError(`Blocky Cloud is unavailable right now (${reason}). The panel keeps working and tries again shortly.`, 0);
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (response.status >= 400 && response.status !== 410) {
    throw new ConsoleError(body?.message || (typeof body?.error === "string" && body.error.length > 20 ? body.error : `Blocky Cloud answered with an error (${response.status}).`), response.status, typeof body?.error === "string" ? body.error : undefined);
  }
  return { status: response.status, body };
}

// ---- Linking ----

function stopLinking() {
  if (runtime.linking?.timer) clearTimeout(runtime.linking.timer);
  runtime.linking = undefined;
}

function schedulePoll(linking: Linking) {
  linking.timer = setTimeout(() => void pollLink(linking), linking.interval * 1000);
  linking.timer.unref();
}

async function pollLink(linking: Linking) {
  if (runtime.linking !== linking) return;
  if (Date.now() > linking.expiresAt) { linking.error = "The code expired before it was approved. Start again."; return; }
  try {
    const { status, body } = await call<{ token?: string; account?: { email: string }; error?: string; message?: string }>("/link/token", { body: { deviceCode: linking.deviceCode } });
    if (runtime.linking !== linking) return;
    if (status === 202) { schedulePoll(linking); return; }
    if (status === 410 || !body.token || !/^[a-f0-9]{64}$/.test(body.token)) {
      linking.error = body.message || "The console didn't accept this link request. Start again.";
      return;
    }
    await saveState({ consoleUrl: consoleUrl(), token: body.token, account: body.account, linkedAt: new Date().toISOString(), failures: 0 });
    (await accounts()).audit(linking.actor || "Admin", `Linked this panel to Blocky Cloud${body.account?.email ? ` (${body.account.email})` : ""}`);
    stopLinking();
    await checkIn().catch(() => undefined);
  } catch (error) {
    if (runtime.linking !== linking) return;
    // A blip while polling isn't fatal: keep trying until the code expires.
    if (error instanceof ConsoleError && error.status === 0) { schedulePoll(linking); return; }
    linking.error = error instanceof Error ? error.message : "Linking failed. Start again.";
  }
}

/** Asks the console for a code to show the owner, and polls until it's approved. */
export async function startLink() {
  if (disabled()) throw new BadRequestError("Blocky Cloud is turned off on this panel.");
  if ((await loadState()).token) throw new ConflictError("This panel is already linked. Unlink it first.");
  stopLinking();
  const { body } = await call<{ deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number }>("/link/start", {
    body: { panelId: await panelId(), name: panelName(), version: panelVersion().version },
  });
  if (!/^[a-f0-9]{64}$/.test(body.deviceCode || "") || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.userCode || "")) throw new ConsoleError("Blocky Cloud sent a link code this panel doesn't understand.", 502);
  const linking: Linking = {
    deviceCode: body.deviceCode, userCode: body.userCode,
    verificationUri: safeConsoleLink(body.verificationUri, "/link"), verificationUriComplete: safeConsoleLink(body.verificationUriComplete, `/link?code=${body.userCode}`),
    expiresAt: Date.now() + Math.min(Math.max(Number(body.expiresIn) || 600, 60), 1800) * 1000,
    interval: Math.min(Math.max(Number(body.interval) || 5, 2), 30),
    actor: await currentActor(),
  };
  runtime.linking = linking;
  schedulePoll(linking);
  return publicLinking(linking);
}

/** Links shown to the owner must point at the console itself, whatever the console sends. */
function safeConsoleLink(value: unknown, fallbackPath: string) {
  const base = consoleUrl();
  return typeof value === "string" && (value === base || value.startsWith(`${base}/`)) ? value : `${base}${fallbackPath}`;
}

export function cancelLink() {
  stopLinking();
}

function publicLinking(linking: Linking) {
  return { userCode: linking.userCode, verificationUri: linking.verificationUri, verificationUriComplete: linking.verificationUriComplete, expiresAt: new Date(linking.expiresAt).toISOString(), error: linking.error };
}

/** Unlinks: tells the console (best effort), then forgets the token and keys. */
export async function unlink() {
  const state = await loadState();
  stopLinking();
  if (state.token) await call("/panel", { method: "DELETE", token: state.token }).catch(() => undefined);
  await saveState(undefined);
  (await accounts()).audit(await currentActor() || "Admin", "Unlinked this panel from Blocky Cloud");
}

// ---- Check-in ----

async function checkInNow() {
  const state = await loadState();
  if (!state.token) return;
  const attemptAt = new Date().toISOString();
  try {
    const servers = checkinServers(await listServers());
    const { body } = await call<unknown>("/checkin", { token: state.token, body: { version: panelVersion().version, name: panelName(), servers } });
    const checkin = parseCheckin(body);
    await updateState((current) => {
      if (current.token !== state.token) return;
      current.checkin = checkin;
      current.account = checkin.account.email ? checkin.account : current.account;
      current.lastCheckinAt = attemptAt;
      current.lastAttemptAt = attemptAt;
      current.lastError = undefined;
      current.failures = 0;
      current.nextCheckinAt = new Date(Date.now() + nextCheckinDelay(0, checkin.nextCheckinSeconds) * 1000).toISOString();
    });
  } catch (error) {
    if (error instanceof ConsoleError && error.status === 401) {
      // Unlinked from the console's side: the token is dead, so stop using it.
      await saveState({ consoleUrl: state.consoleUrl, failures: 0, unlinkedRemotely: true });
      return;
    }
    await updateState((current) => {
      if (current.token !== state.token) return;
      current.failures += 1;
      current.lastAttemptAt = attemptAt;
      current.lastError = error instanceof Error ? error.message : "Check-in failed.";
      current.nextCheckinAt = new Date(Date.now() + nextCheckinDelay(current.failures) * 1000).toISOString();
    });
    throw error;
  }
}

/** Checks in now. Concurrent callers share one request. */
export function checkIn() {
  runtime.checkingIn ??= checkInNow().finally(() => { runtime.checkingIn = undefined; });
  return runtime.checkingIn;
}

/** Called every minute by the scheduler; checks in when one is due. */
export async function cloudTick() {
  if (disabled()) return;
  const state = await loadState();
  if (!state.token) return;
  if (state.nextCheckinAt && Date.now() < new Date(state.nextCheckinAt).getTime()) return;
  await checkIn().catch(() => undefined);
}

// ---- Backups ----

async function freshCredentials(state: CloudState): Promise<BackupCredentials> {
  if (!state.token) throw new BadRequestError("This panel isn't linked to Blocky Cloud. Link it on the Blocky Cloud page first.");
  if (state.checkin && !state.checkin.backup.available) throw new BadRequestError("Blocky Cloud backup isn't part of this account's plan. Subscribe on the console to use it.");
  if (!needsNewCredentials(state.credentials, state.checkin?.backup)) return state.credentials!;
  let body: unknown;
  try { body = (await call<unknown>("/backup/credentials", { token: state.token })).body; }
  catch (error) {
    if (error instanceof ConsoleError && error.status === 403) throw new BadRequestError("Blocky Cloud backup isn't part of this account's plan. Subscribe on the console to use it.");
    throw error;
  }
  const credentials = parseCredentials(body);
  await updateState((current) => {
    if (current.token !== state.token) return;
    current.credentials = credentials;
    // The console asked for new keys at the last check-in; these are them.
    if (current.checkin?.backup.available) current.checkin.backup.renewCredentials = false;
  });
  return credentials;
}

/**
 * The B2 destination behind a "Blocky Cloud" offsite destination, with a key from the console. The
 * key never reaches the offsite settings; it's fetched (and renewed) here each time it's needed.
 */
export async function cloudBackupDestination(panelFolder?: string): Promise<Extract<OffsiteDestination, { kind: "s3" }>> {
  const credentials = await freshCredentials(await loadState());
  return {
    kind: "s3", provider: "b2", endpoint: "", region: credentials.region, bucket: credentials.bucket,
    prefix: cloudPrefix(credentials, panelFolder || await panelId()), accessKeyId: credentials.keyId, secretAccessKey: credentials.applicationKey,
  };
}

/** Whether a "Blocky Cloud" destination can be chosen right now. */
export async function cloudBackupAvailable() {
  const state = await loadState();
  return Boolean(state.token && state.checkin?.backup.available);
}

// ---- What the UI sees ----

/** For the offsite destination form: whether Blocky Cloud can be chosen, and the panel folders it holds. */
export async function cloudOffsiteInfo() {
  if (disabled()) return undefined;
  const state = await loadState().catch(() => undefined);
  if (!state) return undefined;
  const backup = state.checkin?.backup;
  return {
    linked: Boolean(state.token),
    available: Boolean(state.token && backup?.available),
    panelId: await panelId(),
    folders: backup?.available ? backup.folders : [],
  };
}

/** blockylink.net addresses for the server list; empty when not linked. */
export async function cloudServerAddresses() {
  if (disabled()) return {};
  const state = await loadState().catch(() => undefined);
  return state?.token ? cloudAddresses(state.checkin) : {};
}

export async function cloudOverview() {
  if (disabled()) return { enabled: false as const, reason: isDemo() ? "Blocky Cloud isn't available in the demo." : "Blocky Cloud is turned off on this panel (BLOCKY_CLOUD=false)." };
  const state = await loadState();
  const checkin = state.checkin;
  return {
    enabled: true as const,
    consoleUrl: consoleUrl(),
    linked: Boolean(state.token),
    unlinkedRemotely: Boolean(state.unlinkedRemotely),
    linking: runtime.linking ? publicLinking(runtime.linking) : undefined,
    account: state.account,
    linkedAt: state.linkedAt,
    lastCheckinAt: state.lastCheckinAt,
    lastAttemptAt: state.lastAttemptAt,
    nextCheckinAt: state.nextCheckinAt,
    lastError: state.lastError,
    panelName: panelName(),
    panelId: await panelId(),
    outdated: checkin ? !versionAtLeast(panelVersion().version, checkin.minPanelVersion) : false,
    subscription: checkin?.subscription,
    entitlements: checkin?.entitlements,
    names: checkin?.names ?? [],
    backup: checkin?.backup,
    notices: checkin?.notices ?? [],
  };
}

export type CloudOverview = Awaited<ReturnType<typeof cloudOverview>>;
export type { CheckinResponse };
