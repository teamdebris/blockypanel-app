/**
 * Pure helpers for Blocky Cloud: its responses, check-in timing, which credentials are
 * still good, and the addresses players use. Shared by the server, the UI, and tests. The API
 * contract is in docs/cloud-api.md.
 */

import { isServerIcon } from "./server-icons.ts";

export const DEFAULT_CLOUD_URL = "https://cloud.blockypanel.com";
export const CHECKIN_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 3600;
/** Fetch a new backup key when the current one has less than this left. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export type NameState = "active" | "frozen" | "reserved" | "suspended";

export type CloudServerRecord = {
  id: string; label: string; fqdn: string; port: number;
  /** Whether its SRV record is published: Blocky Cloud saw its Java server answer recently. */
  published: boolean; reachable: boolean; checkedAt: string | null;
  bedrockPort: number | null; bedrockReachable: boolean;
};
export type CloudName = {
  name: string; fqdn: string; state: NameState; ip: string | null;
  /** Whether the name's address is published: one of its servers answered recently (Java or Bedrock). */
  published: boolean;
  servers: CloudServerRecord[];
};
export type CloudBackupStatus =
  | { available: false }
  | { available: true; readOnly: boolean; quotaBytes: number; usedBytes: number; deleteAfter: string | null; renewCredentials: boolean; folders: CloudBackupFolder[]; copiesPerDay: number | null };
/** A panel's folder in the account's backup space. Listed even after that panel is unlinked, for restores. */
export type CloudBackupFolder = { id: string; name: string; lastKeyAt: string | null };
export type CloudNotice = { level: "info" | "warning" | "error"; message: string };

export type CheckinResponse = {
  account: { email: string };
  entitlements: { names: number; serversPerName: number; storageBytes: number };
  names: CloudName[];
  backup: CloudBackupStatus;
  minPanelVersion: string;
  notices: CloudNotice[];
  nextCheckinSeconds: number;
};

export type BackupCredentials = {
  provider: "b2"; keyId: string; applicationKey: string; bucket: string; region: string; endpoint: string; prefix: string; readOnly: boolean; expiresAt: string;
};

/** What the panel keeps in panel.db once linked. The token is the panel's only credential. */
export type CloudState = {
  cloudUrl: string;
  token?: string;
  account?: { email: string };
  linkedAt?: string;
  lastCheckinAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  failures: number;
  nextCheckinAt?: string;
  checkin?: CheckinResponse;
  credentials?: BackupCredentials;
  /** Set when Blocky Cloud reported the panel unlinked (from its side). */
  unlinkedRemotely?: boolean;
};

/** Blocky Cloud's address: https, or http only for this machine (development). No trailing slash. */
export function normalizeCloudUrl(value: string | undefined) {
  const raw = (value || DEFAULT_CLOUD_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`BLOCKY_CLOUD_URL isn't a valid URL: ${raw}`); }
  const local = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("BLOCKY_CLOUD_URL must use https (http is only allowed for localhost).");
  if (url.username || url.password || url.search || url.hash) throw new Error("BLOCKY_CLOUD_URL can't contain credentials, a query, or a fragment.");
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

/**
 * Seconds until the next check-in attempt. Successes follow Blocky Cloud's schedule; failures back
 * off from 1 to 60 minutes, with jitter so an outage doesn't end in every panel retrying at once.
 */
export function nextCheckinDelay(failures: number, suggested = CHECKIN_SECONDS, random = Math.random) {
  if (failures <= 0) return Math.min(Math.max(Math.round(suggested), 60), MAX_BACKOFF_SECONDS);
  const base = Math.min(60 * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);
  return Math.round(base * (0.75 + random() * 0.5));
}

function versionParts(version: string) {
  return version.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

/** Whether `version` is at least `minimum` (major.minor.patch; pre-release tags are ignored). */
export function versionAtLeast(version: string, minimum: string) {
  const a = versionParts(version);
  const b = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

/**
 * The blockylink.net address for each server, from the last check-in. A server gets one only while
 * its name publishes (live, or frozen at its last address when it's beyond what the account includes).
 */
export function cloudAddresses(checkin: CheckinResponse | undefined) {
  const addresses: Record<string, string> = {};
  for (const name of checkin?.names ?? []) {
    if (name.state !== "active" && name.state !== "frozen") continue;
    for (const server of name.servers) if (server.published) addresses[server.id] ??= server.fqdn;
  }
  return addresses;
}

/** Whether the panel should ask Blocky Cloud for a new backup key before using Blocky Cloud. */
export function needsNewCredentials(credentials: BackupCredentials | undefined, backup: CloudBackupStatus | undefined, now = Date.now()) {
  if (!credentials) return true;
  if (backup?.available && backup.renewCredentials) return true;
  if (backup?.available && backup.readOnly !== credentials.readOnly) return true;
  return new Date(credentials.expiresAt).getTime() - now < RENEW_BEFORE_MS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the next copy to Blocky Cloud may start, when Blocky Cloud limits copies a day, or null when a
 * copy may start now. Only successful copies count against the limit.
 */
export function nextCopyAllowedAt(copiesPerDay: number | null | undefined, lastSuccessAt: string | undefined, now = Date.now()) {
  if (!copiesPerDay || !lastSuccessAt) return null;
  const next = Date.parse(lastSuccessAt) + DAY_MS / copiesPerDay;
  return Number.isFinite(next) && next > now ? new Date(next).toISOString() : null;
}

/**
 * Each panel keeps its copies in its own folder inside the account's space. A replacement panel
 * can point at another panel's folder (by that panel's ID) to restore its servers.
 */
export function cloudPrefix(credentials: Pick<BackupCredentials, "prefix">, panelFolder: string) {
  if (!SERVER_ID.test(panelFolder)) throw new Error("That isn't a valid panel folder.");
  return `${credentials.prefix.replace(/\/+$/, "")}/panels/${panelFolder}`;
}

const SERVER_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * What check-in sends: each server's ID, name, game port, and Bedrock port (Geyser) if it has one. Servers the owner chose not to publish
 * (backends behind a proxy, archived worlds) are left out, so Blocky Cloud removes their records.
 */
export function checkinServers(servers: { id: string; name: string; port: number; bedrockPort?: number; icon?: string }[], unpublished: readonly string[] = []) {
  const hidden = new Set(unpublished);
  return servers.filter((server) => SERVER_ID.test(server.id) && server.port > 0 && server.port < 65536 && !hidden.has(server.id))
    .slice(0, 200)
    .map((server) => ({
      id: server.id, name: server.name.slice(0, 60) || server.id, port: server.port,
      ...(server.bedrockPort && server.bedrockPort > 0 && server.bedrockPort < 65536 ? { bedrockPort: server.bedrockPort } : {}),
      ...(isServerIcon(server.icon) ? { icon: server.icon } : {}),
    }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the shape of a check-in response before the panel relies on it. */
export function parseCheckin(value: unknown): CheckinResponse {
  if (!isObject(value) || !isObject(value.entitlements) || !Array.isArray(value.names) || !isObject(value.backup)) {
    throw new Error("Blocky Cloud sent a check-in response this panel doesn't understand.");
  }
  const names = value.names.filter(isObject).map((name) => ({
    name: String(name.name ?? ""),
    fqdn: String(name.fqdn ?? ""),
    state: (["active", "frozen", "reserved", "suspended"].includes(String(name.state)) ? name.state : "reserved") as NameState,
    ip: typeof name.ip === "string" ? name.ip : null,
    // Sites from before reachability checks publish everything they list.
    published: name.published === undefined ? typeof name.ip === "string" : name.published === true,
    servers: (Array.isArray(name.servers) ? name.servers : []).filter(isObject).map((server) => ({
      id: String(server.id ?? ""), label: String(server.label ?? ""), fqdn: String(server.fqdn ?? ""), port: Number(server.port) || 0,
      published: server.published === undefined ? true : server.published === true,
      reachable: server.reachable === undefined ? true : server.reachable === true,
      checkedAt: typeof server.checkedAt === "string" ? server.checkedAt : null,
      bedrockPort: Number.isInteger(server.bedrockPort) && Number(server.bedrockPort) > 0 ? Number(server.bedrockPort) : null,
      bedrockReachable: server.bedrockReachable === true,
    })).filter((server) => SERVER_ID.test(server.id) && /^[a-z0-9.-]+$/.test(server.fqdn)),
  })).filter((name) => /^[a-z0-9.-]+$/.test(name.fqdn));
  const entitlements = value.entitlements;
  const backup = value.backup;
  return {
    account: { email: isObject(value.account) ? String(value.account.email ?? "") : "" },
    entitlements: { names: Number(entitlements.names) || 0, serversPerName: Number(entitlements.serversPerName) || 0, storageBytes: Number(entitlements.storageBytes) || 0 },
    names,
    backup: backup.available === true
      ? {
        available: true, readOnly: backup.readOnly === true, quotaBytes: Number(backup.quotaBytes) || 0, usedBytes: Number(backup.usedBytes) || 0,
        deleteAfter: typeof backup.deleteAfter === "string" ? backup.deleteAfter : null, renewCredentials: backup.renewCredentials === true,
        copiesPerDay: typeof backup.copiesPerDay === "number" && backup.copiesPerDay > 0 ? Math.floor(backup.copiesPerDay) : null,
        folders: (Array.isArray(backup.folders) ? backup.folders : []).filter(isObject)
          .map((folder) => ({ id: String(folder.id ?? ""), name: String(folder.name ?? "").slice(0, 100), lastKeyAt: typeof folder.lastKeyAt === "string" ? folder.lastKeyAt : null }))
          .filter((folder) => SERVER_ID.test(folder.id)),
      }
      : { available: false },
    minPanelVersion: typeof value.minPanelVersion === "string" ? value.minPanelVersion : "0.0.0",
    notices: (Array.isArray(value.notices) ? value.notices : []).filter(isObject).map((notice) => ({
      level: (["info", "warning", "error"].includes(String(notice.level)) ? notice.level : "info") as CloudNotice["level"],
      message: String(notice.message ?? "").slice(0, 500),
    })).filter((notice) => notice.message),
    nextCheckinSeconds: Number(value.nextCheckinSeconds) || CHECKIN_SECONDS,
  };
}

/** Checks a backup credentials response; the key must stay inside the account's folder. */
export function parseCredentials(value: unknown): BackupCredentials {
  if (!isObject(value)) throw new Error("Blocky Cloud sent backup credentials this panel doesn't understand.");
  const text = (key: string) => typeof value[key] === "string" ? value[key] as string : "";
  const credentials: BackupCredentials = {
    provider: "b2", keyId: text("keyId"), applicationKey: text("applicationKey"), bucket: text("bucket"), region: text("region"),
    endpoint: text("endpoint"), prefix: text("prefix"), readOnly: value.readOnly === true, expiresAt: text("expiresAt"),
  };
  if (value.provider !== "b2" || !credentials.keyId || !credentials.applicationKey || !/^[a-z0-9-]{3,63}$/.test(credentials.bucket)
    || !/^[a-z0-9-]+$/.test(credentials.region) || !/^accounts\/[a-z0-9]+\/$/.test(credentials.prefix) || Number.isNaN(Date.parse(credentials.expiresAt))) {
    throw new Error("Blocky Cloud sent backup credentials this panel doesn't understand.");
  }
  return credentials;
}

export const nameStateLabels: Record<NameState, string> = { active: "Live", frozen: "Frozen", reserved: "Held", suspended: "Suspended" };
