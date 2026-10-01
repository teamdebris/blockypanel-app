import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import ssh2 from "ssh2";
import { fingerprintOf, parsePublicKey, SshKeyError } from "../lib/ssh-keys.ts";

test("an ed25519 public key parses, keeps its comment, and gets an OpenSSH fingerprint", () => {
  const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: "alex@laptop" });
  const key = parsePublicKey(`  ${pair.public}  `);
  assert.equal(key.type, "ssh-ed25519");
  assert.equal(key.comment, "alex@laptop");
  const blob = Buffer.from(pair.public.split(" ")[1], "base64");
  assert.equal(key.data, blob.toString("base64"));
  // ssh-keygen -l prints unpadded base64 of the SHA-256 of the key blob.
  assert.equal(key.fingerprint, `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`);
  assert.equal(fingerprintOf(blob), key.fingerprint);
});

test("ECDSA and RSA keys of 2048 bits or more are accepted", () => {
  assert.equal(parsePublicKey(ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 }).public).type, "ecdsa-sha2-nistp256");
  assert.equal(parsePublicKey(ssh2.utils.generateKeyPairSync("rsa", { bits: 2048 }).public).type, "ssh-rsa");
});

test("private keys, short RSA keys, junk, and several keys at once are refused with a reason", () => {
  const pair = ssh2.utils.generateKeyPairSync("ed25519");
  const shortRsa = generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
  const shortRsaSsh = (ssh2.utils.parseKey(shortRsa.privateKey) as { getPublicSSH(): Buffer }).getPublicSSH();
  const cases: [string, RegExp][] = [
    [pair.private, /private key/],
    ["", /Paste a public key/],
    ["not a key at all", /doesn't look like/],
    [`${pair.public}\n${pair.public}`, /one key/],
    [`ssh-rsa ${shortRsaSsh.toString("base64")}`, /at least 2048 bits/],
  ];
  for (const [input, reason] of cases) assert.throws(() => parsePublicKey(input), (error) => error instanceof SshKeyError && reason.test(error.message), input.slice(0, 30));
});
