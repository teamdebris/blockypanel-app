import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT } from "./paths";

type Lease = { pid: number; port: number; nonce: string };
const lockFile = path.join(DATA_ROOT, "panel.lock");

/** Two panels must not independently start Java or edit the same worlds. */
export async function claimDataRoot(port: number): Promise<{ existing: true; port: number } | { existing: false; setPort: (port: number) => Promise<void>; release: () => Promise<void> }> {
  await mkdir(DATA_ROOT, { recursive: true });
  const lease: Lease = { pid: process.pid, port, nonce: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lockFile, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
      return {
        existing: false,
        setPort: async (port) => {
          const current = JSON.parse(await readFile(lockFile, "utf8")) as Lease;
          if (current.nonce !== lease.nonce) throw new Error("Another process changed the panel's instance lock.");
          lease.port = port;
          const temporary = `${lockFile}.${lease.nonce}.tmp`;
          await writeFile(temporary, JSON.stringify(lease)); await rename(temporary, lockFile);
        },
        release: async () => {
          const current = await readFile(lockFile, "utf8").then((text) => JSON.parse(text) as Lease).catch(() => undefined);
          if (current?.nonce === lease.nonce) await rm(lockFile, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(lockFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error("panel.lock is invalid. Close all Blocky windows and inspect the lock before starting again.");
      const raw = await readFile(lockFile, "utf8");
      let existing: Lease;
      try { existing = JSON.parse(raw) as Lease; }
      catch {
        if (Date.now() - info.mtimeMs < 30000) throw new Error("Another Blocky window may be starting. Try again in a moment.");
        await rename(lockFile, `${lockFile}.invalid-${Date.now()}`); continue;
      }
      if (!Number.isInteger(existing.pid) || existing.pid < 1 || !Number.isInteger(existing.port) || existing.port < 1 || existing.port > 65535 || typeof existing.nonce !== "string") throw new Error("panel.lock is invalid. Close all Blocky windows and remove the lock before starting again.");
      let alive = true;
      try { process.kill(existing.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) return { existing: true, port: existing.port };
      // The old process ended without removing its lock. Only remove the exact record we read.
      if (await readFile(lockFile, "utf8") === raw) await rm(lockFile);
    }
  }
  throw new Error("Could not claim Blocky's data folder. Close other Blocky windows and try again.");
}
