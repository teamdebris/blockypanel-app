import assert from "node:assert/strict";
import { test } from "node:test";
import { base32Decode, base32Encode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, stepAt, totpCode, verifyTotp } from "../lib/totp.ts";

// RFC 6238 appendix B: the SHA-1 secret is ASCII "12345678901234567890"; codes are the last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("codes match the RFC 6238 test vectors", () => {
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]] as const) {
    assert.equal(totpCode(RFC_SECRET, stepAt(seconds * 1000)), code, String(seconds));
  }
});

test("base32 round-trips and secrets are 160 bits", () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.equal(base32Decode(newTotpSecret()).length, 20);
  assert.throws(() => base32Decode("not base32!"));
});

test("codes allow a little clock drift and can't be reused", () => {
  const secret = newTotpSecret();
  const now = Date.parse("2026-09-25T12:00:10Z");
  const step = stepAt(now);
  assert.equal(verifyTotp(secret, totpCode(secret, step), now), step);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), now), step - 1);
  assert.equal(verifyTotp(secret, totpCode(secret, step + 1), now), step + 1);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 2), now), null);
  assert.equal(verifyTotp(secret, totpCode(secret, step), now, step), null, "already used");
  assert.equal(verifyTotp(secret, "12345", now), null);
  assert.equal(verifyTotp(secret, `${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)}`, now), step, "spaces are fine");
});

test("recovery codes and the QR link are well formed", () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal(normalizeRecoveryCode(" K7QP 3M2X "), "k7qp-3m2x");
  assert.equal(normalizeRecoveryCode("short"), null);
  assert.equal(otpauthUri("ABC", "steve"), "otpauth://totp/Blocky%20Panel:steve?secret=ABC&issuer=Blocky%20Panel&algorithm=SHA1&digits=6&period=30");
});
