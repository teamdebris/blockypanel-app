import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountStore, type Session, type User } from "@/lib/account-store";
import type { Role } from "@/lib/roles";
import { recoveryKey } from "@/lib/session";

/**
 * The account database, shared by the proxy and route handlers. Not "server-only" because the
 * proxy imports it; it can't reach a browser bundle anyway (node:sqlite).
 */

const DEMO_PASSWORD = "blocky-demo";
const DEMO_USERS: { username: string; role: Role }[] = [
  { username: "admin", role: "admin" },
  { username: "operator", role: "operator" },
  { username: "viewer", role: "viewer" },
];

function databasePath() {
  // Mirrors PANEL_ROOT in lib/paths.ts, which is server-only and can't be imported here.
  const root = path.resolve(/* turbopackIgnore: true */ process.env.BLOCKY_STORAGE || "storage");
  return path.join(/* turbopackIgnore: true */ root, "panel", "panel.db");
}

async function open() {
  if (process.env.BLOCKY_DEMO === "true") {
    const store = new AccountStore(new DatabaseSync(":memory:"));
    for (const user of DEMO_USERS) await store.createUser(user.username, DEMO_PASSWORD, user.role);
    return store;
  }
  const file = databasePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  try { chmodSync(file, 0o600); } catch { /* not supported (Windows) */ }
  const store = new AccountStore(db);
  store.pruneExpired();
  return store;
}

// On globalThis so the proxy and route handlers share one connection (and one demo database).
const holder = globalThis as typeof globalThis & { __blockyAccounts?: Promise<AccountStore> };

export function accounts() {
  holder.__blockyAccounts ??= open().catch((error) => { holder.__blockyAccounts = undefined; throw error; });
  return holder.__blockyAccounts;
}

/** The signed-in person as the rest of the panel sees them. */
export type Viewer = { userId: string | null; username: string; role: Role; sessionId: string; recovery: boolean };

function toViewer(resolved: { session: Session; user: User | null }): Viewer {
  if (resolved.session.recovery || !resolved.user) return { userId: null, username: "Recovery", role: "admin", sessionId: resolved.session.id, recovery: true };
  return { userId: resolved.user.id, username: resolved.user.username, role: resolved.user.role, sessionId: resolved.session.id, recovery: false };
}

export async function viewerForToken(token: string | undefined) {
  const resolved = (await accounts()).resolveSession(token, recoveryKey());
  return resolved ? toViewer(resolved) : undefined;
}
