import { createHash } from "node:crypto";
import ssh2 from "ssh2";

/** SSH key helpers for the SFTP server's host key. */

function parses(text: string) {
  const parsed = ssh2.utils.parseKey(text);
  return !(parsed instanceof Error) && !Array.isArray(parsed);
}

/**
 * A new ed25519 key pair in OpenSSH format. ssh2's generator drops a leading zero byte of the key,
 * so about one key in 256 comes out malformed and can't be loaded; those are thrown away.
 */
export function generateEd25519(comment?: string): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519", comment ? { comment } : {});
    if (parses(pair.private) && parses(pair.public)) return { private: pair.private, public: pair.public };
  }
  throw new Error("Couldn't make an ed25519 key.");
}

/** Whether a saved private and public key can both be loaded. */
export function keyPairUsable(key: { private: string; public: string }) {
  return parses(key.private) && parses(key.public);
}

/** "SHA256:..." as `ssh-keygen -l` prints it, for a key's wire-format blob. */
export function fingerprintOf(blob: Buffer) {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}
