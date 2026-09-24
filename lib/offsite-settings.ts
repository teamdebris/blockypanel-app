import "server-only";

import { randomUUID } from "node:crypto";
import { accounts } from "@/lib/auth";
import type { OffsiteDestination } from "@/lib/offsite-core";

/**
 * Offsite backup settings and copy status, kept in panel.db. Separate from lib/offsite.ts so the
 * server list can show copy status without importing the copy machinery.
 */

export type OffsiteSchedule = "after-backup" | "daily";

export type OffsiteSettings = {
  destination: OffsiteDestination;
  schedule: OffsiteSchedule;
  /** Offsite snapshots kept per kind, at least as many as each server keeps locally. */
  keep: number;
  /** The panel's own key to the index at the destination; random, never shown. */
  indexPassword: string;
  panelKeyId: string;
  passphraseKeyId: string;
  configuredAt: string;
};

export type ServerCopyStatus = { lastCopyAt?: string; lastError?: string; lastPruneAt?: string };
export type OffsiteStatus = { lastRunAt?: string; lastSuccessAt?: string; lastError?: string; servers: Record<string, ServerCopyStatus> };

const SETTINGS = "offsite";
const STATUS = "offsite-status";
const PANEL_ID = "panel-id";

export async function offsiteSettings() {
  return (await accounts()).getSetting<OffsiteSettings>(SETTINGS);
}

export async function saveOffsiteSettings(settings: OffsiteSettings | undefined) {
  (await accounts()).setSetting(SETTINGS, settings);
}

export async function offsiteStatus(): Promise<OffsiteStatus> {
  return (await accounts()).getSetting<OffsiteStatus>(STATUS) ?? { servers: {} };
}

/** Read-modify-write; the store is synchronous, so nothing interleaves between the read and the write. */
export async function updateOffsiteStatus(change: (status: OffsiteStatus) => void) {
  const store = await accounts();
  const status = store.getSetting<OffsiteStatus>(STATUS) ?? { servers: {} };
  change(status);
  store.setSetting(STATUS, status);
  return status;
}

export async function resetOffsiteStatus() {
  (await accounts()).setSetting(STATUS, undefined);
}

/** Identifies this panel in offsite indexes, so a restore can tell which panel wrote one. */
export async function panelId() {
  const store = await accounts();
  let id = store.getSetting<string>(PANEL_ID);
  if (!id) { id = randomUUID(); store.setSetting(PANEL_ID, id); }
  return id;
}

/** A server's copy status for the server list, or undefined when offsite backups are off. */
export async function serverOffsiteStatus(serverId: string) {
  if (!(await offsiteSettings())) return undefined;
  const status = (await offsiteStatus()).servers[serverId];
  return { lastCopyAt: status?.lastCopyAt, lastError: status?.lastError };
}
