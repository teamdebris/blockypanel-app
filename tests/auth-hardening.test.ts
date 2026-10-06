import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { AccountError, AccountStore, isWrongCredential, SESSION_MAX_AGE, SESSION_TTL } from "../lib/account-store.ts";
import { readJson } from "../lib/json-body.ts";
import { beginCodeAttempt, beginLoginAttempt, beginPasswordCheck, codeRetryAfter, failuresToRecord, loginRetryAfter, passwordRetryAfter, resetLoginLimits, withCheckSlot } from "../lib/rate-limit.ts";
import { stepAt, totpCode } from "../lib/totp.ts";

// Sign-in, two-factor, and credential hardening (security audit F01-F04, D07, D08).

afterEach(() => {
  resetLoginLimits();
  delete process.env.BLOCKY_TRUST_PROXY;
});

function store() {
  let now = Date.parse("2026-09-25T12:00:00Z");
  const clock = { advance: (ms: number) => { now += ms; }, now: () => now };
  return { accounts: new AccountStore(new DatabaseSync(":memory:"), () => now), clock };
}

/** An account with two-factor on; the enrollment code's step is used up. */
async function twoFactorUser(accounts: AccountStore, clock: { advance: (ms: number) => void; now: () => number }, username = "steve") {
  const user = await accounts.createUser(username, "a-long-password-1", "admin");
  const { secret } = accounts.beginTwoFactor(user.id);
  const recovery = accounts.confirmTwoFactor(user.id, totpCode(secret, stepAt(clock.now())));
  clock.advance(60_000);
  return { user, recovery, code: () => totpCode(secret, stepAt(clock.now())) };
}

async function rejects(work: () => unknown, status: number) {
  await assert.rejects(async () => { await work(); }, (error: unknown) => error instanceof AccountError && error.status === status);
}

/** What /api/auth/login/code does with one code: refuse when over budget, count, check. */
function tryCode(accounts: AccountStore, client: string, challenge: string, code: string) {
  const pending = accounts.loginChallengeUser(challenge);
  if (pending && codeRetryAfter(client, pending.id)) return "limited";
  const attempt = pending ? beginCodeAttempt(client, pending.id) : undefined;
  try { accounts.completeLoginChallenge(challenge, code); }
  catch (error) { if (!isWrongCredential(error)) attempt?.cancel(); return error instanceof AccountError ? error.status : "error"; }
  attempt?.succeed();
  return "ok";
}

test("F01: a new challenge doesn't reset the account's budget for wrong codes", async () => {
  const { accounts, clock } = store();
  const { user, code } = await twoFactorUser(accounts, clock);
  const results: (string | number)[] = [];
  for (let round = 0; round < 4; round += 1) {
    // The correct password, as the login route handles it for a two-factor account.
    const attempt = beginLoginAttempt("direct", user.username);
    assert.ok(await accounts.authenticate(user.username, "a-long-password-1"));
    attempt.cancel();
    const challenge = accounts.createLoginChallenge(user.id, false);
    for (let guess = 0; guess < 5; guess += 1) results.push(tryCode(accounts, "direct", challenge, "000000"));
  }
  assert.deepEqual(results.slice(0, 10), [401, 401, 401, 401, 410, 401, 401, 401, 401, 410]);
  assert.ok(results.slice(10).every((result) => result === "limited"), "after ten wrong codes every further guess is refused");
  assert.ok(codeRetryAfter("direct", user.id) > 0);
  // Even the right code waits, and a correct password doesn't clear the budget.
  beginLoginAttempt("direct", user.username).succeed();
  assert.equal(tryCode(accounts, "direct", accounts.createLoginChallenge(user.id, false), code()), "limited");
  assert.equal(loginRetryAfter("direct", user.username), 0, "the password limits are separate");
});

test("F01: the code budget follows the account across addresses, and each address has its own", async () => {
  process.env.BLOCKY_TRUST_PROXY = "true";
  const { accounts, clock } = store();
  const { user } = await twoFactorUser(accounts, clock);
  for (let guess = 0; guess < 10; guess += 1) {
    tryCode(accounts, `203.0.113.${guess}`, accounts.createLoginChallenge(user.id, false), "000000");
  }
  assert.ok(codeRetryAfter("198.51.100.4", user.id) > 0, "a fresh address is still refused for this account");
  // One address guessing across many accounts runs out too.
  resetLoginLimits();
  for (let index = 0; index < 20; index += 1) beginCodeAttempt("203.0.113.9", `account-${index}`);
  assert.ok(codeRetryAfter("203.0.113.9", "someone-else") > 0);
  assert.equal(codeRetryAfter("198.51.100.4", "someone-else"), 0);
});

test("F01: only the newest challenge works, and a correct code (or recovery code) clears the budget", async () => {
  const { accounts, clock } = store();
  const { user, recovery, code } = await twoFactorUser(accounts, clock);
  const first = accounts.createLoginChallenge(user.id, false);
  const second = accounts.createLoginChallenge(user.id, false);
  assert.equal(accounts.loginChallengeUser(first), undefined);
  await rejects(() => accounts.completeLoginChallenge(first, code()), 410);
  assert.equal(accounts.loginChallengeUser(second)?.id, user.id);
  for (let guess = 0; guess < 3; guess += 1) assert.equal(tryCode(accounts, "direct", second, "000000"), 401);
  assert.equal(tryCode(accounts, "direct", second, recovery[0]), "ok");
  assert.equal(codeRetryAfter("direct", user.id), 0);
  // An unknown or expired challenge isn't a guess at anything, so it isn't counted.
  for (let index = 0; index < 20; index += 1) assert.equal(tryCode(accounts, "direct", "made-up", "000000"), 410);
  const late = accounts.createLoginChallenge(user.id, false);
  clock.advance(5 * 60_000 + 1);
  assert.equal(tryCode(accounts, "direct", late, code()), 410);
  assert.equal(codeRetryAfter("direct", user.id), 0);
});

test("F02: a reset link for a two-factor account needs the code before it signs in", async () => {
  const { accounts, clock } = store();
  await accounts.createFirstAdmin("owner", "a-long-password");
  const user = await accounts.createUser("steve", "a-long-password-1", "operator");
  // Made before two-factor was turned on: the account's current state decides.
  const early = accounts.createResetLink(user.id, "owner");
  const { secret } = accounts.beginTwoFactor(user.id);
  accounts.confirmTwoFactor(user.id, totpCode(secret, stepAt(clock.now())));
  clock.advance(60_000);
  const { challenge } = await accounts.acceptInvite(early.token, "a-new-password-1");
  assert.ok(challenge, "a challenge, not a sign-in");
  assert.deepEqual(accounts.listSessions(user.id), []);
  await rejects(() => accounts.completeLoginChallenge(challenge, "000000"), 401);
  assert.equal(accounts.completeLoginChallenge(challenge, totpCode(secret, stepAt(clock.now()))).user.id, user.id);

  // Without two-factor (and for invites) there's nothing more to ask.
  const plain = await accounts.createUser("sam", "a-long-password-2", "viewer");
  assert.equal((await accounts.acceptInvite(accounts.createResetLink(plain.id, "owner").token, "a-new-password-2")).challenge, undefined);
  assert.equal((await accounts.acceptInvite(accounts.createInvite("viewer", "owner").token, "a-new-password-3", "newbie")).challenge, undefined);

  // A disabled account's challenge can't complete.
  const link = accounts.createResetLink(user.id, "owner");
  accounts.setDisabled(null, user.id, true);
  const disabled = await accounts.acceptInvite(link.token, "a-new-password-4");
  clock.advance(30_000);
  await rejects(() => accounts.completeLoginChallenge(disabled.challenge!, totpCode(secret, stepAt(clock.now()))), 410);
});

test("F03: changing the password revokes reset links, challenges, other sessions, and SFTP passwords", async () => {
  const { accounts, clock } = store();
  const { user, code } = await twoFactorUser(accounts, clock);
  const server = "953dfb01-d789-4e40-a8d3-b4a80258ff7b";
  const here = accounts.createSession({ userId: user.id, persistent: true });
  const elsewhere = accounts.createSession({ userId: user.id, persistent: true });
  const reset = accounts.createResetLink(user.id, "owner");
  const challenge = accounts.createLoginChallenge(user.id, false);
  const ftp = accounts.serverSftpPassword(user.id, server).password;
  const credential = accounts.serverSftpPasswordCredential(user.id, server, ftp)!;
  await accounts.changePassword(user.id, "a-long-password-1", "a-replacement-password", here.session.id);
  assert.equal(accounts.inviteForToken(reset.token), undefined, "an old reset link can't undo the change");
  await rejects(() => accounts.completeLoginChallenge(challenge, code()), 410);
  assert.ok(accounts.resolveSession(here.token));
  assert.equal(accounts.resolveSession(elsewhere.token), undefined);
  assert.equal(accounts.serverSftpPasswordCredential(user.id, server, ftp), undefined);
  assert.equal(accounts.sftpCredentialActive(credential), false, "open SFTP sessions end");
  assert.notEqual(accounts.serverSftpPassword(user.id, server).password, ftp, "a new one is made when it's next shown");
});

test("F03: a reset revokes challenges and SFTP passwords too", async () => {
  const { accounts, clock } = store();
  const { user, code } = await twoFactorUser(accounts, clock);
  const session = accounts.createSession({ userId: user.id, persistent: true });
  const old = accounts.createLoginChallenge(user.id, false);
  const ftp = accounts.serverSftpPassword(user.id, "server-1").password;
  const { challenge } = await accounts.acceptInvite(accounts.createResetLink(user.id, "owner").token, "a-replacement-password");
  await rejects(() => accounts.completeLoginChallenge(old, code()), 410);
  assert.equal(accounts.resolveSession(session.token), undefined);
  assert.equal(accounts.serverSftpPasswordCredential(user.id, "server-1", ftp), undefined);
  assert.ok(accounts.completeLoginChallenge(challenge!, code()));
});

test("F03: turning on two-factor ends the other sessions, keeping this one", async () => {
  const { accounts, clock } = store();
  const user = await accounts.createUser("steve", "a-long-password-1", "viewer");
  const here = accounts.createSession({ userId: user.id, persistent: true });
  const elsewhere = accounts.createSession({ userId: user.id, persistent: true });
  const { secret } = accounts.beginTwoFactor(user.id);
  accounts.confirmTwoFactor(user.id, totpCode(secret, stepAt(clock.now())), here.session.id);
  assert.ok(accounts.resolveSession(here.token));
  assert.equal(accounts.resolveSession(elsewhere.token), undefined);
});

test("F03: sign-in uses the account as it is after the slow password check", async () => {
  const { accounts, clock } = store();
  await accounts.createFirstAdmin("owner", "a-long-password");
  const user = await accounts.createUser("steve", "a-long-password-1", "viewer");
  // Disabled while the password was being checked.
  let pending = accounts.authenticate("steve", "a-long-password-1");
  accounts.setDisabled(null, user.id, true);
  assert.equal(await pending, undefined);
  accounts.setDisabled(null, user.id, false);
  // Two-factor turned on meanwhile: the answer must ask for a code.
  const { secret } = accounts.beginTwoFactor(user.id);
  pending = accounts.authenticate("steve", "a-long-password-1");
  accounts.confirmTwoFactor(user.id, totpCode(secret, stepAt(clock.now())));
  assert.equal((await pending)?.twoFactor, true);
});

test("F04: password checks share a small concurrency limit", async () => {
  let running = 0; let peak = 0;
  const slow = () => withCheckSlot(async () => { running += 1; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 20)); running -= 1; return true; });
  const results = await Promise.all(Array.from({ length: 7 }, slow));
  assert.equal(peak, 4);
  assert.equal(results.filter((result) => result === undefined).length, 3, "the rest are told the panel is busy");
});

test("F04: wrong current passwords have a per-account budget", async () => {
  const { accounts } = store();
  const user = await accounts.createUser("steve", "a-long-password-1", "viewer");
  await assert.rejects(accounts.checkPassword(user.id, "wrong-password"), (error) => isWrongCredential(error));
  await assert.rejects(accounts.changePassword(user.id, "wrong-password", "a-newer-password"), (error) => isWrongCredential(error));
  // A too-short new password isn't a wrong guess at the current one.
  await assert.rejects(accounts.changePassword(user.id, "wrong-password", "short"), (error) => error instanceof AccountError && !isWrongCredential(error));
  for (let attempt = 0; attempt < 4; attempt += 1) beginPasswordCheck(user.id);
  assert.equal(passwordRetryAfter(user.id), 0);
  beginPasswordCheck(user.id).cancel();
  assert.equal(passwordRetryAfter(user.id), 0, "a cancelled check isn't counted");
  beginPasswordCheck(user.id);
  assert.ok(passwordRetryAfter(user.id) > 0);
  assert.equal(passwordRetryAfter("someone-else"), 0);
});

test("F04: concurrent requests with one link don't all hash", async () => {
  const { accounts } = store();
  await accounts.createFirstAdmin("owner", "a-long-password");
  const { token } = accounts.createInvite("viewer", "owner");
  const settled: string[] = [];
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => accounts.acceptInvite(token, "another-password", `friend${index}`).then(
    (value) => { settled.push("won"); return value; },
    (error: unknown) => { settled.push("lost"); throw error; })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.every((result) => result.status === "fulfilled" || (result.reason instanceof AccountError && result.reason.status === 410)));
  // The losers were refused before hashing, so they finish before the one that hashed.
  assert.deepEqual(settled, ["lost", "lost", "lost", "lost", "won"]);
});

test("D07: persistent sessions slide, but not past the maximum age", async () => {
  const { accounts, clock } = store();
  const user = await accounts.createUser("steve", "a-long-password-1", "viewer");
  const { token } = accounts.createSession({ userId: user.id, persistent: true });
  const created = clock.now();
  let elapsed = 0;
  while (elapsed + 24 * 60 * 60 * 1000 < SESSION_MAX_AGE) {
    clock.advance(24 * 60 * 60 * 1000); elapsed += 24 * 60 * 60 * 1000;
    const resolved = accounts.resolveSession(token);
    assert.ok(resolved, `still signed in after ${elapsed / 86_400_000} days`);
    assert.ok(resolved.session.expiresAt <= created + SESSION_MAX_AGE);
  }
  clock.advance(SESSION_MAX_AGE - elapsed);
  assert.equal(accounts.resolveSession(token), undefined);
  assert.ok(SESSION_MAX_AGE > SESSION_TTL.persistent);
});

test("D06: repeated failures are logged at most once a minute, with a count", () => {
  const start = 1_700_000_000_000;
  assert.equal(failuresToRecord("password:a", start), 1);
  assert.equal(failuresToRecord("password:a", start + 1000), 0);
  assert.equal(failuresToRecord("password:a", start + 2000), 0);
  assert.equal(failuresToRecord("password:b", start + 2000), 1, "each account is separate");
  assert.equal(failuresToRecord("password:a", start + 61_000), 3);
});

test("D08: public JSON bodies are read with a size cap", async () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://panel.test/api/auth/login", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  assert.deepEqual(await readJson(post(JSON.stringify({ username: "steve" }))), { username: "steve" });
  const tooLarge = (error: unknown) => error instanceof Error && error.name === "HttpError" && (error as Error & { status: number }).status === 413;
  await assert.rejects(readJson(post("x".repeat(20_000))), tooLarge);
  // Chunked: no Content-Length, counted as it arrives.
  const chunks = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < 40; index += 1) controller.enqueue(new Uint8Array(1024).fill(32)); controller.close(); } });
  await assert.rejects(readJson(post(chunks)), tooLarge);
  await assert.rejects(readJson(post("not json")), SyntaxError);
});
