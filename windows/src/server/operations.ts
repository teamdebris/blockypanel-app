import { HttpError } from "./errors";

const pending = new Map<string, string>();
export const activeOperation = (id: string) => pending.get(id);

/** Reserve before the first await so API requests and scheduled work cannot interleave. */
export async function withServerLock<T>(id: string, operation: string, work: () => Promise<T>): Promise<T> {
  const current = pending.get(id);
  if (current) throw new HttpError(409, `Wait for ${current} to finish first.`);
  pending.set(id, operation);
  try { return await work(); } finally { pending.delete(id); }
}
