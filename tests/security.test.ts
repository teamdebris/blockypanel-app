import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { beginLoginAttempt, clientKey, loginRetryAfter, resetLoginLimits, serialized } from "../lib/rate-limit.ts";
import { safeReturnPath } from "../lib/return-path.ts";
import { recoveryConfigured, recoveryPasswordMatches, recoveryPasswordProblem } from "../lib/session.ts";

afterEach(() => {
  resetLoginLimits();
  delete process.env.BLOCKY_TRUST_PROXY;
});

test("return paths stay on this origin", () => {
  assert.equal(safeReturnPath("/servers/abc/console"), "/servers/abc/console");
  assert.equal(safeReturnPath("/servers?x=1#y"), "/servers?x=1#y");
  for (const value of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "", null, "/login"]) {
    assert.equal(safeReturnPath(value), "/", String(value));
  }
});

test("X-Forwarded-For is ignored unless a trusted proxy is configured, and only the proxy's entry counts", () => {
  // Caddy and nginx append the real client address, so the first entry is whatever the client sent.
  const headers = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
  assert.equal(clientKey(headers), "direct");
  process.env.BLOCKY_TRUST_PROXY = "true";
  assert.equal(clientKey(headers), "203.0.113.9");
  assert.equal(clientKey(new Headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
});

test("a client is blocked after repeated failed logins, and a success forgives them", () => {
  process.env.BLOCKY_TRUST_PROXY = "true";
  for (let attempt = 0; attempt < 8; attempt += 1) beginLoginAttempt("203.0.113.9", `user${attempt}`).fail();
  assert.ok(loginRetryAfter("203.0.113.9", "someone") > 0);
  assert.equal(loginRetryAfter("198.51.100.4", "someone"), 0);
  resetLoginLimits();
  const attempt = beginLoginAttempt("203.0.113.9", "owner");
  attempt.succeed();
  assert.equal(loginRetryAfter("203.0.113.9", "owner"), 0);
});

test("attempts count before the password check, so parallel requests can't slip past the limit", () => {
  // Nine attempts start before any finishes; the ninth sees the first eight already counted.
  const pending = Array.from({ length: 8 }, () => beginLoginAttempt("203.0.113.9", "owner"));
  assert.ok(loginRetryAfter("203.0.113.9", "owner") > 0);
  for (const attempt of pending) attempt.fail();
});

test("without a trusted proxy, one client can't lock everyone out", () => {
  // Every direct client shares the key "direct"; eight failures must not block other usernames.
  for (let attempt = 0; attempt < 8; attempt += 1) beginLoginAttempt("direct", `guess${attempt}`).fail();
  assert.equal(loginRetryAfter("direct", "owner"), 0);
  // A single username still gets locked after repeated failures.
  for (let attempt = 0; attempt < 10; attempt += 1) beginLoginAttempt("direct", "owner").fail();
  assert.ok(loginRetryAfter("direct", "owner") > 0);
});

test("serialized checks run one at a time and refuse a long queue", async () => {
  let running = 0; let peak = 0;
  const work = () => serialized("test", async () => { running += 1; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 5)); running -= 1; return true; }, 3);
  const results = await Promise.allSettled([work(), work(), work(), work(), work()]);
  assert.equal(peak, 1);
  assert.ok(results.some((result) => result.status === "rejected"));
});

test("placeholder or short recovery passwords are treated as not set", () => {
  process.env.BLOCKY_ADMIN_PASSWORD = "replace-with-a-long-password";
  assert.equal(recoveryConfigured(), false);
  assert.match(recoveryPasswordProblem() || "", /example/);
  assert.equal(recoveryPasswordMatches("replace-with-a-long-password"), false);
  process.env.BLOCKY_ADMIN_PASSWORD = "short-one";
  assert.equal(recoveryConfigured(), false);
  process.env.BLOCKY_ADMIN_PASSWORD = "a-properly-long-random-value";
  assert.equal(recoveryConfigured(), true);
  assert.equal(recoveryPasswordProblem(), null);
  delete process.env.BLOCKY_ADMIN_PASSWORD;
});

test("recovery password comparison", () => {
  process.env.BLOCKY_ADMIN_PASSWORD = "correct horse battery staple";
  assert.equal(recoveryPasswordMatches("correct horse battery staple"), true);
  assert.equal(recoveryPasswordMatches("correct horse battery stapl"), false);
  assert.equal(recoveryPasswordMatches("correct horse battery staple "), false);
  delete process.env.BLOCKY_ADMIN_PASSWORD;
  // No recovery password configured means recovery never matches, not even an empty guess.
  assert.equal(recoveryPasswordMatches(""), false);
});
