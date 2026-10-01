import { createHash } from "node:crypto";
import ssh2 from "ssh2";

/**
 * SSH public keys people paste into the account page, for SFTP sign-in. Pure, so tests cover it.
 * Keys are stored as their wire-format blob (what the client presents) plus an OpenSSH fingerprint.
 */

export type SshPublicKey = { type: string; data: string; fingerprint: string; comment: string };

const ACCEPTED = new Set(["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"]);
const MIN_RSA_BITS = 2048;

export class SshKeyError extends Error { constructor(message: string) { super(message); this.name = "SshKeyError"; } }

/** "SHA256:..." as `ssh-keygen -l` prints it, for a key's wire-format blob. */
export function fingerprintOf(blob: Buffer) {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The modulus size of an ssh-rsa blob (string type, mpint e, mpint n). */
function rsaBits(blob: Buffer) {
  let offset = 0;
  const next = () => { const length = blob.readUInt32BE(offset); const value = blob.subarray(offset + 4, offset + 4 + length); offset += 4 + length; return value; };
  next();
  next();
  let modulus = next();
  while (modulus.length && modulus[0] === 0) modulus = modulus.subarray(1);
  return modulus.length ? (modulus.length - 1) * 8 + Math.floor(Math.log2(modulus[0])) + 1 : 0;
}

/** Parses one pasted public key ("ssh-ed25519 AAAA... comment"); throws SshKeyError with a readable reason. */
export function parsePublicKey(text: string): SshPublicKey {
  const line = text.trim();
  if (!line) throw new SshKeyError("Paste a public key.");
  if (/PRIVATE KEY/.test(line)) throw new SshKeyError("That's a private key. Paste the public key instead (the .pub file); never share the private one.");
  if (/[\r\n]/.test(line)) throw new SshKeyError("Paste one key, on a single line.");
  const parsed = ssh2.utils.parseKey(line);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new SshKeyError("That doesn't look like an SSH public key. It starts with ssh-ed25519, ecdsa-sha2-…, or ssh-rsa.");
  if (parsed.isPrivateKey()) throw new SshKeyError("That's a private key. Paste the public key instead (the .pub file).");
  if (!ACCEPTED.has(parsed.type)) throw new SshKeyError(`${parsed.type} keys aren't accepted. Use ed25519 (ssh-keygen -t ed25519), ECDSA, or RSA of at least ${MIN_RSA_BITS} bits.`);
  const blob = parsed.getPublicSSH();
  if (parsed.type === "ssh-rsa" && rsaBits(blob) < MIN_RSA_BITS) throw new SshKeyError(`RSA keys need at least ${MIN_RSA_BITS} bits. An ed25519 key is shorter and stronger.`);
  const comment = line.split(/\s+/).slice(2).join(" ").slice(0, 100);
  return { type: parsed.type, data: blob.toString("base64"), fingerprint: fingerprintOf(blob), comment };
}
