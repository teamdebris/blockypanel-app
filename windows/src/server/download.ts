import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import release from "../../../package.json";

const USER_AGENT = `BlockyPanel-Windows/${release.version} (+https://blockypanel.com)`;

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
  return response.json() as Promise<T>;
}

/**
 * Downloads to a temporary name and renames when complete, so an interrupted download never looks
 * finished. `onProgress` gets a fraction from 0 to 1 when the size is known.
 */
export async function download(url: string, target: string, options: { sha1?: string; sha256?: string; onProgress?: (fraction: number) => void } = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${new URL(url).host} answered ${response.status}.`);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = options.sha256 ? createHash("sha256") : options.sha1 ? createHash("sha1") : undefined;
  let received = 0;
  const temp = `${target}.part`;
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    hash?.update(chunk);
    if (total) options.onProgress?.(received / total);
  });
  try {
    await pipeline(source, createWriteStream(temp));
    const expected = options.sha256 ?? options.sha1;
    if (hash && expected && hash.digest("hex") !== expected.toLowerCase()) throw new Error("The download didn't match its checksum. Try again.");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
