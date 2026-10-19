import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./errors";
import release from "../../../package.json";

const USER_AGENT = `BlockyPanel-Windows/${release.version} (+https://blockypanel.com)`;

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
  if (!response.body) throw new HttpError(502, "The download service returned an empty response.");
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 ** 2) { await reader.cancel(); throw new HttpError(502, "The download service returned too much metadata."); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/**
 * Downloads to a temporary name and renames when complete, so an interrupted download never looks
 * finished. `onProgress` gets a fraction from 0 to 1 when the size is known.
 */
export async function download(url: string, target: string, options: { sha1?: string; sha256?: string; sha512?: string; md5?: string; maxBytes?: number; allowedHosts?: string[]; onProgress?: (fraction: number) => void } = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  let current = new URL(url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (options.allowedHosts && (current.protocol !== "https:" || !options.allowedHosts.includes(current.hostname) || current.username || current.password || (current.port && current.port !== "443"))) throw new Error("The download address is not an approved HTTPS host.");
    response = await fetch(current, { headers: { "User-Agent": USER_AGENT }, redirect: options.allowedHosts ? "manual" : "follow", signal: AbortSignal.timeout(300000) });
    if (!options.allowedHosts || ![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("The download redirected too many times.");
    current = new URL(location, current);
  }
  if (!response) throw new Error("The download service did not respond.");
  if (!response.ok || !response.body) throw new Error(`Download failed: ${new URL(url).host} answered ${response.status}.`);
  const total = Number(response.headers.get("content-length")) || 0;
  const max = options.maxBytes ?? 512 * 1024 ** 2;
  if (total > max) { await response.body.cancel(); throw new Error("That download is larger than this panel allows."); }
  const algorithm = options.sha512 ? "sha512" : options.sha256 ? "sha256" : options.sha1 ? "sha1" : options.md5 ? "md5" : undefined;
  const hash = algorithm ? createHash(algorithm) : undefined;
  let received = 0;
  const temp = `${target}.${randomUUID()}.part`;
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    received += chunk.length;
    if (received > max) { done(new Error("That download is larger than this panel allows.")); return; }
    hash?.update(chunk);
    if (total) options.onProgress?.(received / total);
    done(null, chunk);
  } });
  try {
    await pipeline(source, meter, createWriteStream(temp, { flags: "wx" }));
    const expected = options.sha512 ?? options.sha256 ?? options.sha1 ?? options.md5;
    if (hash && expected && hash.digest("hex") !== expected.toLowerCase()) throw new Error("The download didn't match its checksum. Try again.");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
