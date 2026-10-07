import { scryptSync } from "node:crypto";
import { secretsEqual } from "./passwords.ts";

export const COOKIE_NAME = "blocky_session";

/**
 * The cookie holds a random session token; the session itself (user, expiry) lives in the
 * database, so signing someone out takes effect immediately. Without `maxAgeSeconds` the cookie
 * lasts until the browser closes ("Keep me signed in" off).
 */
export function sessionCookieOptions(maxAgeSeconds?: number) {
  return { httpOnly: true, sameSite: "strict" as const, secure: process.env.BLOCKY_COOKIE_SECURE === "true", path: "/", ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }) };
}

export const clearedCookie = { ...sessionCookieOptions(0), expires: new Date(0) };

const RECOVERY_PASSWORD_MIN = 16;

/**
 * Why BLOCKY_ADMIN_PASSWORD can't be used, or null when it's fine (or unset). It's a single
 * password with no lockout that grants admin, so the example value from .env.example and short
 * values are refused rather than accepted.
 */
export function recoveryPasswordProblem() {
  const value = process.env.BLOCKY_ADMIN_PASSWORD || "";
  if (!value) return null;
  if (/^replace-with/i.test(value) || /^(change-?me|password|admin)$/i.test(value)) return "BLOCKY_ADMIN_PASSWORD is still the example value from .env.example.";
  if (value.length < RECOVERY_PASSWORD_MIN) return `BLOCKY_ADMIN_PASSWORD is shorter than ${RECOVERY_PASSWORD_MIN} characters.`;
  return null;
}

/** BLOCKY_ADMIN_PASSWORD proves ownership at first run and enables the recovery sign-in. */
export function recoveryConfigured() {
  return Boolean(process.env.BLOCKY_ADMIN_PASSWORD) && !recoveryPasswordProblem();
}

export function recoveryPasswordMatches(provided: string) {
  return recoveryConfigured() && secretsEqual(provided, process.env.BLOCKY_ADMIN_PASSWORD || "");
}

let cachedRecoveryKey: { password: string; key: string } | undefined;

/**
 * Identifies the current recovery password without storing it: recovery sessions carry this and
 * end when BLOCKY_ADMIN_PASSWORD changes or is removed. It's kept in the database, so it's a slow
 * scrypt hash (like account passwords) rather than a fast one that a copied database could be
 * guessed against. Worked out once per password, since every request checks it.
 */
export function recoveryKey() {
  if (!recoveryConfigured()) return undefined;
  const password = process.env.BLOCKY_ADMIN_PASSWORD || "";
  if (cachedRecoveryKey?.password !== password) {
    const key = scryptSync(password.normalize("NFKC"), "blocky-recovery", 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    cachedRecoveryKey = { password, key: `s1.${key.toString("base64url")}` };
  }
  return cachedRecoveryKey.key;
}
