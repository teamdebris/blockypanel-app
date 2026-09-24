import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword, hashToken, newToken, PASSWORD_MAX, PASSWORD_MIN, unknownUserHash, verifyPassword } from "./passwords.ts";
import { isRole, type Role } from "./roles.ts";

/**
 * Users, invites, sessions, and the account audit log, in SQLite. Every method is synchronous
 * apart from password hashing, so each database step runs to completion without interleaving.
 * Kept free of Next.js imports so tests can use it with an in-memory database.
 */

export class AccountError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) { super(message); this.name = "AccountError"; this.status = status; this.field = field; }
}

export type User = { id: string; username: string; role: Role; createdAt: number; lastLoginAt: number | null; lastSeenAt: number | null; disabled: boolean };
export type Session = { id: string; userId: string | null; recovery: boolean; persistent: boolean; createdAt: number; lastSeenAt: number; expiresAt: number; userAgent: string; ip: string };
type Invite = { id: string; kind: "invite" | "reset"; role: Role | null; userId: string | null; username?: string; createdBy: string; createdAt: number; expiresAt: number };
type AuditEntry = { id: number; at: number; actor: string; message: string };

const HOUR = 60 * 60 * 1000;
export const SESSION_TTL = { persistent: 14 * 24 * HOUR, browser: 12 * HOUR, recovery: HOUR };
export const INVITE_TTL = 24 * HOUR;
// last_seen_at is written at most this often, so polling doesn't turn every request into a write.
const TOUCH_INTERVAL = 60 * 1000;
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;

type Row = Record<string, unknown>;

function toUser(row: Row): User {
  return { id: String(row.id), username: String(row.username), role: row.role as Role, createdAt: Number(row.created_at), lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at), lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at), disabled: Boolean(row.disabled) };
}

function toSession(row: Row): Session {
  return { id: String(row.id), userId: row.user_id == null ? null : String(row.user_id), recovery: Boolean(row.recovery), persistent: Boolean(row.persistent), createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), expiresAt: Number(row.expires_at), userAgent: String(row.user_agent || ""), ip: String(row.ip || "") };
}

function toInvite(row: Row): Invite {
  return { id: String(row.id), kind: row.kind as Invite["kind"], role: row.role == null ? null : row.role as Role, userId: row.user_id == null ? null : String(row.user_id), username: row.username == null ? undefined : String(row.username), createdBy: String(row.created_by), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
}

function assertUsername(username: string) {
  if (!USERNAME.test(username)) throw new AccountError(400, "Usernames are 3 to 32 letters, numbers, dots, dashes, or underscores.", "username");
}

function assertPassword(password: string) {
  if (password.length < PASSWORD_MIN) throw new AccountError(400, `Use at least ${PASSWORD_MIN} characters.`, "password");
  if (password.length > PASSWORD_MAX) throw new AccountError(400, `Use at most ${PASSWORD_MAX} characters.`, "password");
}

export class AccountStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        last_seen_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        role TEXT,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        recovery INTEGER NOT NULL DEFAULT 0,
        persistent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT,
        recovery_key TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Databases created before recovery sessions were tied to the recovery password.
    const columns = db.prepare("PRAGMA table_info(sessions)").all().map((column) => String(column.name));
    if (!columns.includes("recovery_key")) db.exec("ALTER TABLE sessions ADD COLUMN recovery_key TEXT");
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // ---- Users ----

  hasActiveAdmin() {
    return Boolean(this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND disabled = 0 LIMIT 1").get());
  }

  listUsers(): User[] {
    return this.db.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE").all().map(toUser);
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row ? toUser(row) : undefined;
  }

  async createUser(username: string, password: string, role: Role): Promise<User> {
    assertUsername(username);
    assertPassword(password);
    const hash = await hashPassword(password);
    return this.insertUser(username, hash, role);
  }

  /** First-run setup: creates the owner's admin account, only while no active admin exists. */
  async createFirstAdmin(username: string, password: string): Promise<User> {
    assertUsername(username);
    assertPassword(password);
    const hash = await hashPassword(password);
    return this.transaction(() => {
      if (this.hasActiveAdmin()) throw new AccountError(409, "Blocky is already set up. Sign in instead.");
      return this.insertUser(username, hash, "admin");
    });
  }

  private insertUser(username: string, passwordHash: string, role: Role): User {
    if (this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new AccountError(409, "That username is taken.", "username");
    const id = randomUUID();
    this.db.prepare("INSERT INTO users (id, username, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, username, role, passwordHash, this.now());
    return this.getUser(id)!;
  }

  /** The user for a correct username and password, else undefined. Takes the same time either way. */
  async authenticate(username: string, password: string): Promise<User | undefined> {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    const valid = await verifyPassword(password, row ? String(row.password_hash) : await unknownUserHash());
    if (!row || !valid || row.disabled) return undefined;
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(this.now(), String(row.id));
    return toUser(row);
  }

  /** Throws when `userId` is the last active admin and the change would remove that. */
  private assertNotLastAdmin(userId: string) {
    const user = this.getUser(userId);
    if (!user || user.role !== "admin" || user.disabled) return;
    const others = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(userId) as { n: number };
    if (!others.n) throw new AccountError(409, "This is the only admin. Make someone else an admin first.");
  }

  setRole(actorId: string | null, userId: string, role: Role) {
    if (!isRole(role)) throw new AccountError(400, "Unknown role.");
    if (actorId === userId) throw new AccountError(409, "You can't change your own role.");
    this.transaction(() => {
      if (!this.getUser(userId)) throw new AccountError(404, "User not found.");
      if (role !== "admin") this.assertNotLastAdmin(userId);
      this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
      // A new role takes effect on the next request anyway; signing out makes a demotion obvious.
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    });
  }

  setDisabled(actorId: string | null, userId: string, disabled: boolean) {
    if (actorId === userId && disabled) throw new AccountError(409, "You can't disable your own account.");
    this.transaction(() => {
      if (!this.getUser(userId)) throw new AccountError(404, "User not found.");
      if (disabled) this.assertNotLastAdmin(userId);
      this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
      if (disabled) this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    });
  }

  deleteUser(actorId: string | null, userId: string) {
    if (actorId === userId) throw new AccountError(409, "You can't delete your own account.");
    this.transaction(() => {
      const user = this.getUser(userId);
      if (!user) throw new AccountError(404, "User not found.");
      this.assertNotLastAdmin(userId);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    });
  }

  async changePassword(userId: string, current: string, next: string, keepSessionId?: string) {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    if (!row) throw new AccountError(404, "User not found.");
    if (!(await verifyPassword(current, String(row.password_hash)))) throw new AccountError(400, "Your current password is incorrect.", "current");
    assertPassword(next);
    const hash = await hashPassword(next);
    this.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId || "");
    });
  }

  // ---- Sessions ----

  /** `recoveryKey` identifies the recovery password a recovery session was opened with. */
  createSession(options: { userId: string | null; recovery?: boolean; recoveryKey?: string; persistent: boolean; userAgent?: string; ip?: string }) {
    const token = newToken();
    const now = this.now();
    const ttl = options.recovery ? SESSION_TTL.recovery : options.persistent ? SESSION_TTL.persistent : SESSION_TTL.browser;
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions (id, token_hash, user_id, recovery, persistent, created_at, last_seen_at, expires_at, user_agent, ip, recovery_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, hashToken(token), options.userId, options.recovery ? 1 : 0, options.persistent && !options.recovery ? 1 : 0, now, now, now + ttl, (options.userAgent || "").slice(0, 300), (options.ip || "").slice(0, 64), options.recovery ? options.recoveryKey || null : null);
    return { token, session: this.getSession(id)!, maxAgeSeconds: Math.floor(ttl / 1000) };
  }

  private getSession(id: string) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  /**
   * The live session and its user for a cookie token. Expired sessions and sessions of disabled or
   * deleted users are removed. Persistent sessions slide forward while in use. Recovery sessions
   * only live while `recoveryKey` (the current recovery password) matches the one they opened with,
   * so changing or removing BLOCKY_ADMIN_PASSWORD ends them.
   */
  resolveSession(token: string | undefined, recoveryKey?: string): { session: Session; user: User | null } | undefined {
    if (!token) return undefined;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token));
    if (!row) return undefined;
    const session = toSession(row);
    const now = this.now();
    const user = session.userId ? this.getUser(session.userId) ?? null : null;
    const recoveryRevoked = session.recovery && (!recoveryKey || row.recovery_key !== recoveryKey);
    if (session.expiresAt <= now || recoveryRevoked || (session.userId && (!user || user.disabled)) || (!session.userId && !session.recovery)) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      return undefined;
    }
    if (now - session.lastSeenAt >= TOUCH_INTERVAL) {
      const expiresAt = session.persistent ? now + SESSION_TTL.persistent : session.expiresAt;
      this.db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(now, expiresAt, session.id);
      if (user) this.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, user.id);
      session.lastSeenAt = now;
      session.expiresAt = expiresAt;
    }
    return { session, user };
  }

  listSessions(userId: string): Session[] {
    return this.db.prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC").all(userId, this.now()).map(toSession);
  }

  deleteSession(id: string, userId?: string) {
    if (userId) this.db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(id, userId);
    else this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteSessionByToken(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  /** Signs a user out everywhere, optionally keeping one session (the caller's own). */
  deleteUserSessions(userId: string, exceptSessionId?: string) {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, exceptSessionId || "");
  }

  pruneExpired() {
    const now = this.now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM invites WHERE expires_at <= ? OR used_at IS NOT NULL").run(now - 7 * 24 * HOUR);
  }

  // ---- Invites and password-reset links ----

  createInvite(role: Role, createdBy: string) {
    if (!isRole(role)) throw new AccountError(400, "Unknown role.");
    return this.insertInvite("invite", role, null, createdBy);
  }

  createResetLink(userId: string, createdBy: string) {
    if (!this.getUser(userId)) throw new AccountError(404, "User not found.");
    return this.transaction(() => {
      // Only the newest reset link works.
      this.db.prepare("DELETE FROM invites WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL").run(userId);
      return this.insertInvite("reset", null, userId, createdBy);
    });
  }

  private insertInvite(kind: Invite["kind"], role: Role | null, userId: string | null, createdBy: string) {
    const token = newToken();
    const id = randomUUID();
    const now = this.now();
    this.db.prepare("INSERT INTO invites (id, token_hash, kind, role, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, hashToken(token), kind, role, userId, createdBy, now, now + INVITE_TTL);
    return { token, invite: this.pendingInvite(id)! };
  }

  private pendingInvite(id: string) {
    const row = this.db.prepare("SELECT invites.*, users.username FROM invites LEFT JOIN users ON users.id = invites.user_id WHERE invites.id = ? AND used_at IS NULL AND expires_at > ?").get(id, this.now());
    return row ? toInvite(row) : undefined;
  }

  /** A usable invite or reset link for a token, else undefined (unknown, used, or expired). */
  inviteForToken(token: string): Invite | undefined {
    const row = this.db.prepare("SELECT invites.*, users.username FROM invites LEFT JOIN users ON users.id = invites.user_id WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(hashToken(token), this.now());
    return row ? toInvite(row) : undefined;
  }

  listInvites(): Invite[] {
    return this.db.prepare("SELECT invites.*, users.username FROM invites LEFT JOIN users ON users.id = invites.user_id WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(this.now()).map(toInvite);
  }

  revokeInvite(id: string) {
    this.db.prepare("DELETE FROM invites WHERE id = ? AND used_at IS NULL").run(id);
  }

  /** Uses an invite (creating the account) or a reset link (setting a new password). Single use. */
  async acceptInvite(token: string, password: string, username?: string): Promise<User> {
    const invite = this.inviteForToken(token);
    if (!invite) throw new AccountError(410, "This link has expired or was already used. Ask an admin for a new one.");
    assertPassword(password);
    if (invite.kind === "invite") assertUsername(username || "");
    const hash = await hashPassword(password);
    return this.transaction(() => {
      // Re-check after the await: another request may have used the link meanwhile.
      const claimed = this.db.prepare("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(this.now(), invite.id, this.now());
      if (!claimed.changes) throw new AccountError(410, "This link has expired or was already used. Ask an admin for a new one.");
      if (invite.kind === "invite") return this.insertUser(username!, hash, invite.role!);
      const user = this.getUser(invite.userId!);
      if (!user) throw new AccountError(410, "This account no longer exists.");
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      return user;
    });
  }

  // ---- Panel settings (JSON values, e.g. offsite backups) ----

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }

  /** Stores a value, or removes the setting when `value` is undefined. */
  setSetting(key: string, value: unknown) {
    if (value === undefined) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ---- Audit log (account events; server activity lives in the control state) ----

  audit(actor: string, message: string) {
    this.db.prepare("INSERT INTO audit (at, actor, message) VALUES (?, ?, ?)").run(this.now(), actor.slice(0, 64), message.slice(0, 300));
    this.db.prepare("DELETE FROM audit WHERE id <= (SELECT MAX(id) - 500 FROM audit)").run();
  }

  listAudit(limit = 50): AuditEntry[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit).map((row) => ({ id: Number(row.id), at: Number(row.at), actor: String(row.actor), message: String(row.message) }));
  }
}
