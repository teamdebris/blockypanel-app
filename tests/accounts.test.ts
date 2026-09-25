import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AccountError, AccountStore, INVITE_TTL, SESSION_TTL } from "../lib/account-store.ts";
import { hashPassword, verifyPassword } from "../lib/passwords.ts";
import { API_ACCESS, apiAccess, pageAccess, roleAtLeast } from "../lib/roles.ts";
import { stepAt, totpCode } from "../lib/totp.ts";

function store() {
  let now = 1_700_000_000_000;
  const clock = { advance: (ms: number) => { now += ms; } };
  return { accounts: new AccountStore(new DatabaseSync(":memory:"), () => now), clock };
}

async function rejects(work: () => unknown, status: number) {
  await assert.rejects(async () => { await work(); }, (error: unknown) => error instanceof AccountError && error.status === status);
}

test("passwords hash with a salt and verify", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("wrong horse battery", a), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("first-run setup creates one admin, then refuses", async () => {
  const { accounts } = store();
  assert.equal(accounts.hasActiveAdmin(), false);
  const owner = await accounts.createFirstAdmin("owner", "a-long-password");
  assert.equal(owner.role, "admin");
  await rejects(() => accounts.createFirstAdmin("intruder", "a-long-password"), 409);
});

test("sign-in checks the password, ignores username case, and refuses disabled users", async () => {
  const { accounts } = store();
  const owner = await accounts.createFirstAdmin("Owner", "a-long-password");
  assert.equal((await accounts.authenticate("owner", "a-long-password"))?.id, owner.id);
  assert.equal(await accounts.authenticate("owner", "wrong-password"), undefined);
  assert.equal(await accounts.authenticate("nobody", "a-long-password"), undefined);
  const friend = await accounts.createUser("friend", "another-password", "viewer");
  accounts.setDisabled(owner.id, friend.id, true);
  assert.equal(await accounts.authenticate("friend", "another-password"), undefined);
});

test("short passwords and bad usernames are rejected", async () => {
  const { accounts } = store();
  await rejects(() => accounts.createUser("ok-name", "short", "viewer"), 400);
  await rejects(() => accounts.createUser("no spaces", "a-long-password", "viewer"), 400);
  await rejects(() => accounts.createUser("x", "a-long-password", "viewer"), 400);
});

test("sessions expire, slide while used, and end when the user is disabled", async () => {
  const { accounts, clock } = store();
  const owner = await accounts.createFirstAdmin("owner", "a-long-password");
  const friend = await accounts.createUser("friend", "another-password", "operator");
  const browser = accounts.createSession({ userId: friend.id, persistent: false });
  const kept = accounts.createSession({ userId: friend.id, persistent: true });
  assert.equal(accounts.resolveSession(browser.token)?.user?.id, friend.id);
  clock.advance(SESSION_TTL.browser + 1);
  assert.equal(accounts.resolveSession(browser.token), undefined);
  // Persistent sessions keep sliding while in use.
  clock.advance(SESSION_TTL.persistent - SESSION_TTL.browser - 1000);
  assert.ok(accounts.resolveSession(kept.token));
  clock.advance(SESSION_TTL.persistent - 1000);
  assert.ok(accounts.resolveSession(kept.token));
  accounts.setDisabled(owner.id, friend.id, true);
  assert.equal(accounts.resolveSession(kept.token), undefined);
  assert.equal(accounts.resolveSession("made-up-token"), undefined);
});

test("recovery sessions last an hour, have no user, and end when the recovery password changes", () => {
  const { accounts, clock } = store();
  const recovery = accounts.createSession({ userId: null, recovery: true, persistent: true, recoveryKey: "key-1" });
  assert.equal(accounts.resolveSession(recovery.token, "key-2"), undefined);
  const again = accounts.createSession({ userId: null, recovery: true, persistent: true, recoveryKey: "key-1" });
  // Recovery turned off (no key) ends it too.
  assert.equal(accounts.resolveSession(again.token, undefined), undefined);
  const third = accounts.createSession({ userId: null, recovery: true, persistent: true, recoveryKey: "key-1" });
  const resolved = accounts.resolveSession(third.token, "key-1");
  assert.equal(resolved?.user, null);
  assert.equal(resolved?.session.recovery, true);
  clock.advance(SESSION_TTL.recovery + 1);
  assert.equal(accounts.resolveSession(third.token, "key-1"), undefined);
});

test("invites are single use, expire, and create the account with the invited role", async () => {
  const { accounts, clock } = store();
  await accounts.createFirstAdmin("owner", "a-long-password");
  const { token } = accounts.createInvite("operator", "owner");
  assert.equal(accounts.inviteForToken(token)?.role, "operator");
  const friend = await accounts.acceptInvite(token, "another-password", "friend");
  assert.equal(friend.role, "operator");
  await rejects(() => accounts.acceptInvite(token, "another-password", "friend2"), 410);
  const late = accounts.createInvite("viewer", "owner");
  clock.advance(INVITE_TTL + 1);
  assert.equal(accounts.inviteForToken(late.token), undefined);
  await rejects(() => accounts.acceptInvite(late.token, "another-password", "late"), 410);
});

test("an invite can't take an existing username", async () => {
  const { accounts } = store();
  await accounts.createFirstAdmin("owner", "a-long-password");
  const { token } = accounts.createInvite("viewer", "owner");
  await rejects(() => accounts.acceptInvite(token, "another-password", "OWNER"), 409);
  // The failed attempt didn't use up the invite.
  assert.ok(accounts.inviteForToken(token));
});

test("reset links set a new password, sign the user out, and only the newest works", async () => {
  const { accounts } = store();
  await accounts.createFirstAdmin("owner", "a-long-password");
  const friend = await accounts.createUser("friend", "old-password-1", "viewer");
  const session = accounts.createSession({ userId: friend.id, persistent: true });
  const first = accounts.createResetLink(friend.id, "owner");
  const second = accounts.createResetLink(friend.id, "owner");
  assert.equal(accounts.inviteForToken(first.token), undefined);
  await accounts.acceptInvite(second.token, "new-password-1");
  assert.equal(accounts.resolveSession(session.token), undefined);
  assert.ok(await accounts.authenticate("friend", "new-password-1"));
  assert.equal(await accounts.authenticate("friend", "old-password-1"), undefined);
});

test("the last admin can't be demoted, disabled, or deleted, and nobody changes their own role", async () => {
  const { accounts } = store();
  const owner = await accounts.createFirstAdmin("owner", "a-long-password");
  const second = await accounts.createUser("second", "a-long-password", "admin");
  assert.throws(() => accounts.setRole(owner.id, owner.id, "viewer"), AccountError);
  accounts.setRole(owner.id, second.id, "viewer");
  // Now owner is the only admin: a recovery session (no actor) still can't remove them.
  assert.throws(() => accounts.setRole(null, owner.id, "viewer"), AccountError);
  assert.throws(() => accounts.setDisabled(null, owner.id, true), AccountError);
  assert.throws(() => accounts.deleteUser(null, owner.id), AccountError);
  accounts.setRole(owner.id, second.id, "admin");
  accounts.deleteUser(second.id, owner.id);
  assert.equal(accounts.listUsers().length, 1);
});

test("changing a password needs the current one and signs out other sessions", async () => {
  const { accounts } = store();
  const owner = await accounts.createFirstAdmin("owner", "a-long-password");
  const here = accounts.createSession({ userId: owner.id, persistent: true });
  const elsewhere = accounts.createSession({ userId: owner.id, persistent: true });
  await rejects(() => accounts.changePassword(owner.id, "wrong", "a-newer-password", here.session.id), 400);
  await accounts.changePassword(owner.id, "a-long-password", "a-newer-password", here.session.id);
  assert.ok(accounts.resolveSession(here.token));
  assert.equal(accounts.resolveSession(elsewhere.token), undefined);
});

test("roles are ordered", () => {
  assert.equal(roleAtLeast("admin", "operator"), true);
  assert.equal(roleAtLeast("operator", "admin"), false);
  assert.equal(roleAtLeast("viewer", "viewer"), true);
  assert.equal(roleAtLeast(undefined, "viewer"), false);
});

test("the permission table covers every API route and method, and denies anything else", () => {
  const root = path.join(import.meta.dirname, "..", "app", "api");
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (name === "route.ts") files.push(full); } };
  walk(root);
  const routes = new Set<string>();
  for (const file of files) {
    const route = `/api/${path.relative(root, path.dirname(file)).split(path.sep).join("/")}`;
    routes.add(route);
    const methods = [...readFileSync(file, "utf8").matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]);
    for (const method of methods) assert.ok(API_ACCESS[route]?.[method], `${method} ${route} has no entry in API_ACCESS`);
  }
  for (const route of Object.keys(API_ACCESS)) assert.ok(routes.has(route), `API_ACCESS lists ${route}, which doesn't exist`);
  assert.equal(apiAccess("/api/servers/abc/files", "GET"), "admin");
  assert.equal(apiAccess("/api/servers/abc/console", "POST"), "operator");
  assert.equal(apiAccess("/api/servers/abc/events", "GET"), "viewer");
  assert.equal(apiAccess("/api/servers/abc/events", "DELETE"), undefined);
  assert.equal(apiAccess("/api/not-a-route", "GET"), undefined);
  assert.equal(apiAccess("/api/servers/abc/../../users", "GET"), undefined);
  assert.equal(pageAccess("/users"), "admin");
  assert.equal(pageAccess("/invite/abc"), "public");
  assert.equal(pageAccess("/servers/abc"), "viewer");
});

test("panel settings store JSON values and can be removed", () => {
  const { accounts } = store();
  assert.equal(accounts.getSetting("offsite"), undefined);
  accounts.setSetting("offsite", { keep: 14, destination: { kind: "folder", path: "/mnt/backup" } });
  accounts.setSetting("offsite", { keep: 30 });
  assert.deepEqual(accounts.getSetting("offsite"), { keep: 30 });
  accounts.setSetting("offsite", undefined);
  assert.equal(accounts.getSetting("offsite"), undefined);
});

test("two-factor sign-in: setup, codes, replay protection, recovery codes, and the attempt limit", async () => {
  let now = Date.parse("2026-09-25T12:00:00Z");
  const clock = { advance: (ms: number) => { now += ms; } };
  const accounts = new AccountStore(new DatabaseSync(":memory:"), () => now);
  const user = await accounts.createUser("steve", "a-long-password-1", "operator");
  const { secret } = accounts.beginTwoFactor(user.id);
  const code = () => totpCode(secret, stepAt(now));
  await rejects(() => accounts.confirmTwoFactor(user.id, "000000"), 400);
  const recovery = accounts.confirmTwoFactor(user.id, code());
  assert.equal(recovery.length, 10);
  assert.equal(accounts.getUser(user.id)?.twoFactor, true);
  await rejects(() => accounts.beginTwoFactor(user.id), 409);

  // The code used to confirm setup can't be reused to sign in.
  let challenge = accounts.createLoginChallenge(user.id, true);
  await rejects(() => accounts.completeLoginChallenge(challenge, code()), 401);
  clock.advance(30_000);
  const signedIn = accounts.completeLoginChallenge(challenge, code());
  assert.equal(signedIn.user.id, user.id);
  assert.equal(signedIn.persistent, true);
  await rejects(() => accounts.completeLoginChallenge(challenge, code()), 410); // spent

  // Recovery codes work once each.
  challenge = accounts.createLoginChallenge(user.id, false);
  assert.equal(accounts.completeLoginChallenge(challenge, recovery[0].toUpperCase()).usedRecoveryCode, true);
  challenge = accounts.createLoginChallenge(user.id, false);
  await rejects(() => accounts.completeLoginChallenge(challenge, recovery[0]), 401);
  assert.equal(accounts.recoveryCodesLeft(user.id), 9);

  // Five wrong codes end the sign-in attempt (the count survives each failed request).
  challenge = accounts.createLoginChallenge(user.id, false);
  for (let attempt = 1; attempt < 5; attempt += 1) await rejects(() => accounts.completeLoginChallenge(challenge, "000000"), 401);
  await rejects(() => accounts.completeLoginChallenge(challenge, "000000"), 410);
  clock.advance(30_000);
  await rejects(() => accounts.completeLoginChallenge(challenge, code()), 410);

  // Challenges expire.
  challenge = accounts.createLoginChallenge(user.id, false);
  clock.advance(5 * 60_000 + 1);
  await rejects(() => accounts.completeLoginChallenge(challenge, code()), 410);

  accounts.disableTwoFactor(user.id);
  assert.equal(accounts.getUser(user.id)?.twoFactor, false);
  assert.equal(accounts.recoveryCodesLeft(user.id), 0);
});
