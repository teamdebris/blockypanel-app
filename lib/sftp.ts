import "server-only";

import { mkdir } from "node:fs/promises";
import ssh2 from "ssh2";
import { runAsActor } from "@/lib/actor";
import { accounts } from "@/lib/auth";
import { managedServerNames } from "@/lib/docker";
import { unknownUserHash, verifyPassword } from "@/lib/passwords";
import { serverDataPath } from "@/lib/paths";
import { beginLoginAttempt, loginRetryAfter, withCheckSlot } from "@/lib/rate-limit";
import { createSftpServer, type SessionSummary, splitSftpLogin, type SftpUser } from "@/lib/sftp-core";
import { fingerprintOf } from "@/lib/ssh-keys";
import { recordEvent } from "@/lib/store";

/**
 * The panel's SFTP server: SSH keys and generated SFTP passwords from Your account, for admins
 * (files are admin-only), each session confined to one server's data folder (see lib/sftp-core.ts).
 * The login is "<username>.<server ID>"; the first 8 characters of the ID are enough.
 */

const HOST_KEY = "sftp-host-key";
const SERVER_PREFIX_MIN = 8;
const AUDIT_EVERY_MS = 10 * 60_000;

export function sftpPort() {
  const port = Number(process.env.BLOCKY_SFTP_PORT || 2022);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 2022;
}

export function sftpEnabled() {
  return process.env.BLOCKY_DEMO !== "true" && process.env.BLOCKY_SFTP !== "false";
}

type HostKey = { private: string; public: string };

/** The server's host key, made on first use and kept in panel.db so clients can pin it. */
async function hostKey(): Promise<HostKey> {
  const store = await accounts();
  const existing = store.getSetting<HostKey>(HOST_KEY);
  if (existing?.private && existing.public) return existing;
  const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: "blocky-panel" });
  const key = { private: pair.private, public: pair.public };
  store.setSetting(HOST_KEY, key);
  return key;
}

/** What the UI shows for connecting: the port and the host key's fingerprint to check on first connect. */
export async function sftpInfo(): Promise<{ enabled: boolean; port?: number; fingerprint?: string }> {
  if (!sftpEnabled()) return { enabled: false };
  const key = ssh2.utils.parseKey((await hostKey()).public);
  if (key instanceof Error || Array.isArray(key)) return { enabled: false };
  return { enabled: true, port: sftpPort(), fingerprint: fingerprintOf(key.getPublicSSH()) };
}

/** The server a login's suffix names: its full ID, or a prefix of at least 8 characters that only one ID has. */
async function serverFor(suffix: string) {
  const servers = await managedServerNames();
  if (servers.has(suffix)) return { id: suffix, name: servers.get(suffix)! };
  if (suffix.length < SERVER_PREFIX_MIN) return undefined;
  const matches = [...servers].filter(([id]) => id.startsWith(suffix));
  return matches.length === 1 ? { id: matches[0][0], name: matches[0][1] } : undefined;
}

const lastAudit = new Map<string, number>();

async function signedIn(account: { id: string; username: string }, server: { id: string; name: string }, credentialId: string, method: string): Promise<SftpUser> {
  const store = await accounts();
  store.touchSftpCredential(credentialId);
  // One line in the account log per person and server every few minutes: clients open several connections.
  const auditKey = `${account.id}:${server.id}`;
  if (Date.now() - (lastAudit.get(auditKey) || 0) > AUDIT_EVERY_MS) {
    lastAudit.set(auditKey, Date.now());
    if (lastAudit.size > 1000) lastAudit.delete(lastAudit.keys().next().value!);
    store.audit(account.username, `Signed in over SFTP (${method}) to ${server.name}`);
  }
  const root = serverDataPath(server.id);
  await mkdir(root, { recursive: true });
  return { username: account.username, serverId: server.id, root, stillAllowed: async () => (await accounts()).sftpCredentialActive(credentialId) };
}

async function resolveLogin(login: string) {
  const parts = splitSftpLogin(login);
  if (!parts) return undefined;
  const account = (await accounts()).sftpAccount(parts.account);
  if (!account) return undefined;
  const server = await serverFor(parts.server);
  return server ? { account, server } : undefined;
}

/** SFTP attempts are throttled like sign-ins, in their own per-name bucket so they can't lock anyone out of the web panel. */
const throttleName = (login: string) => `sftp:${splitSftpLogin(login)?.account ?? login}`.toLowerCase();

async function passwordLogin(login: string, password: string, address: string) {
  const client = `sftp:${address}`;
  const name = throttleName(login);
  if (loginRetryAfter(client, name)) return undefined;
  const attempt = beginLoginAttempt(client, name);
  const resolved = await resolveLogin(login);
  const store = await accounts();
  const checked = await withCheckSlot(async () => ({
    // An unknown login still costs a hash check, so timing doesn't reveal which logins exist.
    credential: resolved ? await store.sftpPasswordCredential(resolved.account.id, password) : (await verifyPassword(password, await unknownUserHash()), undefined),
  }));
  if (!checked) { attempt.cancel(); return undefined; }
  if (!resolved || !checked.credential) {
    attempt.fail();
    await new Promise((resolve) => setTimeout(resolve, 750));
    return undefined;
  }
  attempt.succeed();
  return signedIn(resolved.account, resolved.server, checked.credential, "password");
}

async function keyLogin(login: string, key: Buffer) {
  const resolved = await resolveLogin(login);
  if (!resolved) return undefined;
  const credential = (await accounts()).sftpKeyCredential(resolved.account.id, key.toString("base64"));
  return credential ? signedIn(resolved.account, resolved.server, credential, "SSH key") : undefined;
}

function describeSummary(summary: SessionSummary) {
  const count = (list: string[], one: string, many = `${one}s`) => `${list.length} ${list.length === 1 ? one : many}`;
  const sample = (list: string[]) => (list.length ? ` (${list.slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""})` : "");
  const parts = [
    summary.uploaded.length ? `uploaded or changed ${count(summary.uploaded, "file")}${sample(summary.uploaded)}` : "",
    summary.deleted.length ? `deleted ${count(summary.deleted, "item")}${sample(summary.deleted)}` : "",
    summary.created.length ? `created ${count(summary.created, "folder")}` : "",
    summary.renamed.length ? `renamed ${count(summary.renamed, "item")}` : "",
  ].filter(Boolean);
  return `Files changed over SFTP: ${parts.join("; ")}.`;
}

const holder = globalThis as typeof globalThis & { __blockySftp?: ReturnType<typeof createSftpServer> };

/** Starts listening once per process. A port that's taken is logged, not fatal: the panel still runs. */
export async function startSftpServer() {
  if (!sftpEnabled() || holder.__blockySftp) return;
  const key = await hostKey();
  const server = createSftpServer({
    hostKey: key.private,
    auth: {
      password: passwordLogin,
      publicKey: (login, blob) => keyLogin(login, blob),
      failed: (login, address) => beginLoginAttempt(`sftp:${address}`, throttleName(login)).fail(),
    },
    onSessionEnd: (user, summary) => { void runAsActor(user.username, () => recordEvent(user.serverId, "sftp", describeSummary(summary), "info")).catch(() => undefined); },
  });
  holder.__blockySftp = server;
  // In a container every interface is right (Compose decides what's published); running with Node, localhost.
  const host = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  const port = sftpPort();
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `Blocky couldn't start SFTP: port ${port} is in use. Set BLOCKY_SFTP_PORT to a free port.` : "Blocky's SFTP server failed", error.code === "EADDRINUSE" ? "" : error);
  });
  server.listen(port, host, () => console.log(`Blocky SFTP listening on ${host}:${port}`));
}
