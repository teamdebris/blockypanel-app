/**
 * Bounded collection of what external commands print (restic, rcon-cli, ssh-keygen), so a runaway
 * or hostile command can't grow the panel's memory without limit. No Next.js imports, so it's tested directly.
 */

/** Output the panel parses (JSON listings, RCON replies). Far above anything real. */
export const MAX_STDOUT_BYTES = 4 * 1024 ** 2;
/** Error text only ever ends up in a message, so only its end is kept. */
export const MAX_STDERR_BYTES = 64 * 1024;

export class OutputTooLargeError extends Error {
  constructor(command: string, limit = MAX_STDOUT_BYTES) { super(`${command} printed more than ${Math.round(limit / 1024 ** 2)} MB, more than the panel expects, so it was stopped.`); this.name = "OutputTooLargeError"; }
}

/**
 * Collects chunks up to `limit` bytes. Past it, everything is dropped and `onOverflow` runs once
 * (to stop the command); `overflowed` tells the caller to fail. Decoded once at the end, so a
 * character split across chunks stays intact.
 */
export function outputCollector(limit: number, onOverflow: () => void = () => undefined) {
  let chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  const overflow = () => { if (overflowed) return; overflowed = true; chunks = []; onOverflow(); };
  return {
    add(chunk: Buffer | string) {
      if (overflowed) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limit) { overflow(); return; }
      chunks.push(buffer);
    },
    /** For output counted elsewhere (a line that never ends). */
    overflow,
    get overflowed() { return overflowed; },
    text() { return Buffer.concat(chunks).toString("utf8"); },
  };
}

/** Keeps only the last `limit` bytes: for error output, where the end says what went wrong. */
export function tailCollector(limit: number) {
  let kept = Buffer.alloc(0);
  return {
    add(chunk: Buffer | string) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      kept = Buffer.concat([kept, buffer]);
      if (kept.length > limit) kept = kept.subarray(kept.length - limit);
    },
    text() { return kept.toString("utf8"); },
  };
}
