import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encrypts the few secrets the panel has to show again later, like each server's SFTP password.
 * AES-256-GCM with a key kept in its own file next to panel.db, so a copy of the database alone
 * doesn't give them away. Sealed values look like "v1.<iv>.<tag>.<ciphertext>" (base64url).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("A secret box key is 32 bytes.");
    this.key = key;
  }

  /** A box with a throwaway key, for in-memory stores (tests and the demo). */
  static random() {
    return new SecretBox(randomBytes(32));
  }

  seal(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  }

  /** The original text, or undefined when the value was sealed with another key or was tampered with. */
  open(sealed: string): string | undefined {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

/** Compares two secrets in constant time, whatever their lengths. */
export function sameSecret(a: string, b: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
