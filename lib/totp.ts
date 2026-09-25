import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time codes (RFC 6238, the kind authenticator apps show): HMAC-SHA1, 30-second
 * steps, 6 digits. Pure, so it's tested against the RFC's published values.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, as RFC 4226 recommends), base32-encoded. */
export function newTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function stepAt(time: number) {
  return Math.floor(time / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The step a code is valid for (allowing one step of clock drift either way), or null. Codes for
 * `lastStep` or earlier are refused, so a code can't be used twice.
 */
export function verifyTotp(secret: string, code: string, time: number, lastStep = -1) {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const now = stepAt(time);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

/** The link authenticator apps read from the QR code. */
export function otpauthUri(secret: string, account: string, issuer = "Blocky Panel") {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** Ten single-use recovery codes like "k7qp-3m2x". Only their hashes are stored. */
export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const text = base32Encode(randomBytes(5)).toLowerCase();
    return `${text.slice(0, 4)}-${text.slice(4, 8)}`;
  });
}

export function normalizeRecoveryCode(code: string) {
  const clean = code.toLowerCase().replace(/[^a-z2-7]/g, "");
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : null;
}
