import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { currentViewer } from "@/lib/auth-server";

/** Who performed an action: the signed-in username ("Recovery" for a recovery sign-in). */
const storage = new AsyncLocalStorage<string>();

/** The acting person's name: the captured value inside background work, else the request's session, else "". */
export async function currentActor() {
  const captured = storage.getStore();
  if (captured !== undefined) return captured;
  return (await currentViewer())?.username || "";
}

/** Runs background work with the requesting person's name attached, after the request has ended. */
export function runAsActor<T>(actor: string, work: () => Promise<T>) {
  return storage.run(actor, work);
}
