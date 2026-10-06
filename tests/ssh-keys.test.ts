import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import ssh2 from "ssh2";
import { fingerprintOf, generateEd25519, keyPairUsable } from "../lib/ssh-keys.ts";

test("a key's fingerprint is what ssh-keygen -l prints", () => {
  const pair = generateEd25519("blocky-panel");
  const blob = (ssh2.utils.parseKey(pair.public) as { getPublicSSH(): Buffer }).getPublicSSH();
  // Unpadded base64 of the SHA-256 of the key blob.
  assert.equal(fingerprintOf(blob), `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`);
});

test("generated ed25519 keys always load (ssh2 makes a malformed one about 1 time in 256)", () => {
  for (let i = 0; i < 2000; i++) {
    const pair = generateEd25519("blocky-panel");
    assert.ok(keyPairUsable(pair));
    assert.match(pair.public, /^ssh-ed25519 /);
  }
  // A key with the leading byte dropped (31 bytes) is refused, as ssh-keygen would never make one.
  assert.equal(keyPairUsable({ private: generateEd25519().private, public: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAH1oZ3dZS9rcupZVKHce8kjEo+o4ux3v/WtWje8SmvqI= x" }), false);
});
