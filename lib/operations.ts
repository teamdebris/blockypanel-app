import "server-only";

import { currentActor, runAsActor } from "@/lib/actor";
import { ConflictError } from "@/lib/errors";
import { recordEvent } from "@/lib/store";

export type OperationKind = "create" | "start" | "stop" | "restart" | "backup" | "update" | "settings" | "restore" | "remove" | "backup-delete" | "scheduled-backup" | "reroll" | "scheduled-restart";

export type ActiveOperation = { kind: OperationKind; label: string; step?: string; startedAt: string; actor?: string };
export type FinishedOperation = ActiveOperation & { ok: boolean; message: string; finishedAt: string };

type OperationRegistry = { active: Map<string, ActiveOperation>; finished: Map<string, FinishedOperation> };

// Kept on globalThis so dev-mode module reloads don't lose track of running work.
const registryGlobal = globalThis as typeof globalThis & { __blockyOperations?: OperationRegistry };
const registry = registryGlobal.__blockyOperations ??= { active: new Map(), finished: new Map() };

export function activeOperation(serverId: string) {
  return registry.active.get(serverId);
}

export function lastOperation(serverId: string) {
  return registry.finished.get(serverId);
}

/** Updates the human-readable step of the server's running operation, shown live in the UI. */
export function setOperationStep(serverId: string, step: string) {
  const current = registry.active.get(serverId);
  if (current) current.step = step;
}

function acquire(serverId: string, kind: OperationKind, label: string, actor?: string) {
  const current = registry.active.get(serverId);
  if (current) throw new ConflictError(`${current.label} is already in progress for this server. Wait for it to finish.`);
  const operation: ActiveOperation = { kind, label, startedAt: new Date().toISOString(), ...(actor ? { actor } : {}) };
  registry.active.set(serverId, operation);
  return operation;
}

function release(serverId: string, operation: ActiveOperation) {
  if (registry.active.get(serverId) === operation) registry.active.delete(serverId);
}

/**
 * Runs `work` while holding the server's lock and fails fast with 409 if another operation holds
 * it. The caller reports the outcome itself, so nothing is published as a finished operation.
 */
export async function withServerLock<T>(serverId: string, kind: OperationKind, label: string, work: () => Promise<T>): Promise<T> {
  const operation = acquire(serverId, kind, label);
  try { return await work(); }
  finally { release(serverId, operation); }
}

/**
 * Starts long-running work (image pulls, backups, restores, health checks) without holding the HTTP
 * request open, so reverse-proxy timeouts can't report a failure for work that is still running.
 * A conflicting operation is rejected before this resolves.
 */
export async function startServerOperation(serverId: string, kind: OperationKind, label: string, work: () => Promise<unknown>) {
  const actor = await currentActor();
  const operation = acquire(serverId, kind, label, actor);
  void runAsActor(actor, async () => {
    const finish = (ok: boolean, message: string) => {
      release(serverId, operation);
      // Published so the UI can announce background work that finished while the panel was open.
      registry.finished.set(serverId, { ...operation, ok, message, finishedAt: new Date().toISOString() });
    };
    try {
      await work();
      finish(true, `${label} completed.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} failed.`;
      finish(false, message);
      await recordEvent(serverId, kind, `${label} failed: ${message}`, "error").catch(() => undefined);
    }
  });
  return { message: `${label} started.`, operation };
}
