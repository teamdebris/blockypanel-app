import { copyFile, mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** One writer; cache changes become visible only after the atomic disk write succeeds. */
export class JsonStore<T> {
  private loaded?: Promise<T>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private empty: () => T, private valid: (value: unknown) => value is T) {}
  private async readDisk() {
    const parse = async (file: string) => {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!this.valid(value)) throw new Error("Unexpected data format.");
      return value;
    };
    try { return await parse(this.file); }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      try {
        const recovered = await parse(`${this.file}.bak`);
        if (!missing) await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(recovered, null, 2));
        await rename(temporary, this.file);
        console.error(`Recovered ${path.basename(this.file)} from its previous copy. The damaged file was preserved.`);
        return recovered;
      } catch (backupError) {
        if (missing && (backupError as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
        throw new Error(`${path.basename(this.file)} could not be read. Restore a valid copy before continuing; your data has not been overwritten.`);
      }
    }
  }
  async read() { this.loaded ??= this.readDisk(); return structuredClone(await this.loaded); }
  async change<R>(work: (state: T) => R | Promise<R>): Promise<R> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const state = await this.read();
      const result = await work(state);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state, null, 2));
        await copyFile(this.file, `${this.file}.bak`).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        await rename(temp, this.file);
        this.loaded = Promise.resolve(state);
      } finally { await rm(temp, { force: true }); }
      return structuredClone(result);
    });
    this.queue = next;
    return next;
  }
}
