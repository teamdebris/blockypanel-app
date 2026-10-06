import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt cost: N=2^15 takes ~50-100 ms and 32 MB per hash, slow enough to make offline guessing
// expensive without making sign-in feel slow. The parameters are stored with each hash, so they
// can be raised later without invalidating existing passwords.
const COST = 32768;
const BLOCK = 8;
const PARALLEL = 1;
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

function derive(password: string, salt: Buffer, cost: number, block: number, parallel: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: cost, r: block, p: parallel, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key));
  });
}

/** Returns "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, BLOCK, PARALLEL);
  return ["scrypt", COST, BLOCK, PARALLEL, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, cost, block, parallel, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), Number(cost), Number(block), Number(parallel));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to verify against when the username doesn't exist, so the response time doesn't reveal it. */
let dummyHash: Promise<string> | undefined;
export function unknownUserHash() {
  dummyHash ??= hashPassword(randomBytes(18).toString("base64url"));
  return dummyHash;
}

/** A random bearer token for cookies and links. Only its hash is ever stored. */
export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

/** Compares two strings in constant time (after hashing, so lengths don't leak either). */
export function secretsEqual(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
