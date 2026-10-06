import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AccountError, AccountStore, SEALED_SETTINGS } from "../lib/account-store.ts";
import { SecretBox } from "../lib/secret-box.ts";
import { stepAt, totpCode } from "../lib/totp.ts";

/** The secrets kept in panel.db are sealed with the key in panel/secret.key, so a copy of the database alone doesn't give them away. */

async function rejects(work: () => unknown, status: number) {
  await assert.rejects(async () => { await work(); }, (error: unknown) => error instanceof AccountError && error.status === status);
}

const raw = (db: DatabaseSync, sql: string, ...params: string[]) => String(Object.values(db.prepare(sql).get(...params) ?? {})[0]);
const CLOUD = { cloudUrl: "https://cloud.example", token: "bearer-token-not-in-the-db", failures: 0, credentials: { keyId: "key-id", applicationKey: "application-key-not-in-the-db" } };

test("credential settings are sealed at rest and read back; other settings stay plain", () => {
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountStore(db, Date.now, SecretBox.random());
  assert.deepEqual([...SEALED_SETTINGS].sort(), ["cloud", "offsite", "offsite-ssh-key", "sftp-host-key"]);
  accounts.setSetting("cloud", CLOUD);
  accounts.setSetting("offsite", { destination: { kind: "s3", secretAccessKey: "s3-secret-not-in-the-db" }, indexPassword: "index-password-not-in-the-db" });
  accounts.setSetting("offsite-ssh-key", { privateKey: "-----BEGIN OPENSSH PRIVATE KEY----- not in the db", publicKey: "ssh-ed25519 AAAA" });
  accounts.setSetting("sftp-host-key", { private: "host-private-not-in-the-db", public: "ssh-ed25519 BBBB" });
  accounts.setSetting("panel-id", "4f0c");
  for (const key of SEALED_SETTINGS) {
    const stored = raw(db, "SELECT value FROM settings WHERE key = ?", key);
    assert.match(stored, /^v1\./);
    assert.ok(!stored.includes("not-in-the-db") && !stored.includes("not in the db"), key);
  }
  assert.equal(raw(db, "SELECT value FROM settings WHERE key = ?", "panel-id"), "\"4f0c\"");
  assert.deepEqual(accounts.getSetting("cloud"), CLOUD);
  assert.equal(accounts.getSetting<{ indexPassword: string }>("offsite")?.indexPassword, "index-password-not-in-the-db");
  assert.equal(accounts.getSetting("panel-id"), "4f0c");
  assert.equal(accounts.settingUnreadable("cloud"), false);
  assert.equal(accounts.settingUnreadable("never-set"), false);
  accounts.setSetting("cloud", undefined);
  assert.equal(accounts.getSetting("cloud"), undefined);
});

test("TOTP secrets are sealed at rest, and sign-in works the same", async () => {
  let now = Date.parse("2026-09-25T12:00:00Z");
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountStore(db, () => now, SecretBox.random());
  const user = await accounts.createUser("steve", "a-long-password-1", "operator");
  const { secret } = accounts.beginTwoFactor(user.id);
  const pending = raw(db, "SELECT totp_pending FROM users WHERE id = ?", user.id);
  assert.match(pending, /^v1\./);
  assert.ok(!pending.includes(secret));
  accounts.confirmTwoFactor(user.id, totpCode(secret, stepAt(now)));
  const stored = raw(db, "SELECT totp_secret FROM users WHERE id = ?", user.id);
  assert.match(stored, /^v1\./);
  assert.ok(!stored.includes(secret));
  assert.equal(accounts.getUser(user.id)?.twoFactor, true);
  now += 30_000;
  const challenge = accounts.createLoginChallenge(user.id, false);
  assert.equal(accounts.completeLoginChallenge(challenge, totpCode(secret, stepAt(now))).user.id, user.id);
});

test("plain values from earlier versions are read, and sealed on the next start", async () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const db = new DatabaseSync(":memory:");
  const box = SecretBox.random();
  const before = new AccountStore(db, () => now, box);
  const user = await before.createUser("steve", "a-long-password-1", "operator");
  const other = await before.createUser("alex", "a-long-password-2", "operator");
  // What an earlier version left behind: plain TOTP secrets and plain JSON settings.
  db.prepare("UPDATE users SET totp_secret = ?, totp_last_step = -1 WHERE id = ?").run("JBSWY3DPEHPK3PXP", user.id);
  db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run("KRSXG5CTMVRXEZLU", other.id);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("cloud", JSON.stringify(CLOUD));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("offsite-excluded", "[\"a\"]");
  // Still read as they are until then.
  assert.deepEqual(before.getSetting("cloud"), CLOUD);
  const early = before.createLoginChallenge(user.id, false);
  assert.equal(before.completeLoginChallenge(early, totpCode("JBSWY3DPEHPK3PXP", stepAt(now))).user.id, user.id);

  const after = new AccountStore(db, () => now + 30_000, box);
  assert.match(raw(db, "SELECT totp_secret FROM users WHERE id = ?", user.id), /^v1\./);
  assert.match(raw(db, "SELECT totp_pending FROM users WHERE id = ?", other.id), /^v1\./);
  assert.match(raw(db, "SELECT value FROM settings WHERE key = ?", "cloud"), /^v1\./);
  assert.equal(raw(db, "SELECT value FROM settings WHERE key = ?", "offsite-excluded"), "[\"a\"]");
  assert.deepEqual(after.getSetting("cloud"), CLOUD);
  const challenge = after.createLoginChallenge(user.id, false);
  assert.equal(after.completeLoginChallenge(challenge, totpCode("JBSWY3DPEHPK3PXP", stepAt(now + 30_000))).user.id, user.id);
  assert.ok(after.confirmTwoFactor(other.id, totpCode("KRSXG5CTMVRXEZLU", stepAt(now + 30_000))).length);

  // Sealing again on a later start leaves sealed values alone.
  const sealed = raw(db, "SELECT value FROM settings WHERE key = ?", "cloud");
  new AccountStore(db, Date.now, box);
  assert.equal(raw(db, "SELECT value FROM settings WHERE key = ?", "cloud"), sealed);
});

test("with a replaced key: sealed settings read as unset, and two-factor accepts only recovery codes", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const now = Date.parse("2026-09-25T12:00:00Z");
  const db = new DatabaseSync(":memory:");
  const before = new AccountStore(db, () => now, SecretBox.random());
  const user = await before.createUser("steve", "a-long-password-1", "operator");
  const pendingUser = await before.createUser("alex", "a-long-password-2", "operator");
  const { secret } = before.beginTwoFactor(user.id);
  const recovery = before.confirmTwoFactor(user.id, totpCode(secret, stepAt(now)));
  const pending = before.beginTwoFactor(pendingUser.id);
  before.setSetting("cloud", CLOUD);
  before.setSetting("sftp-host-key", { private: "p", public: "q" });
  const sealed = raw(db, "SELECT value FROM settings WHERE key = ?", "cloud");

  const after = new AccountStore(db, () => now + 60_000, SecretBox.random());
  // Not touched by the start-up sealing, so the old key file would still open them.
  assert.equal(raw(db, "SELECT value FROM settings WHERE key = ?", "cloud"), sealed);
  assert.equal(after.getSetting("cloud"), undefined);
  assert.equal(after.settingUnreadable("cloud"), true);
  assert.equal(after.getSetting("sftp-host-key"), undefined);
  // Saving again replaces it with a value the new key opens.
  after.setSetting("cloud", { cloudUrl: "https://cloud.example", failures: 0 });
  assert.equal(after.settingUnreadable("cloud"), false);
  assert.deepEqual(after.getSetting("cloud"), { cloudUrl: "https://cloud.example", failures: 0 });

  // Two-factor stays on; authenticator codes are refused, recovery codes still sign in.
  assert.equal(after.getUser(user.id)?.twoFactor, true);
  let challenge = after.createLoginChallenge(user.id, false);
  await rejects(() => after.completeLoginChallenge(challenge, totpCode(secret, stepAt(now + 60_000))), 401);
  challenge = after.createLoginChallenge(user.id, false);
  assert.equal(after.completeLoginChallenge(challenge, recovery[0]).usedRecoveryCode, true);
  // A setup in progress has to be started again.
  await rejects(() => after.confirmTwoFactor(pendingUser.id, totpCode(pending.secret, stepAt(now + 60_000))), 409);
  after.disableTwoFactor(user.id);
  assert.equal(after.getUser(user.id)?.twoFactor, false);
});
