import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword, hashToken, newToken, PASSWORD_MAX, PASSWORD_MIN, unknownUserHash, verifyPassword } from "./passwords.ts";
import { isRole, type Role } from "./roles.ts";
import { SecretBox, sameSecret } from "./secret-box.ts";
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, verifyTotp } from "./totp.ts";

/**
 * Users, invites, sessions, and the account audit log, in SQLite. Every method is synchronous
 * apart from password hashing, so each database step runs to completion without interleaving.
 * Kept free of Next.js imports so tests can use it with an in-memory database.
 */

export class AccountError extends Error {
  readonly status: number;
  readonly field?: string;
  /** A wrong password or code (not a missing account or a too-short new password): counts toward attempt limits. */
  readonly wrongCredential: boolean;
  constructor(status: number, message: string, field?: string, wrongCredential = false) { super(message); this.name = "AccountError"; this.status = status; this.field = field; this.wrongCredential = wrongCredential; }
}

/** Matched by name, like apiError(): the bundle can hold two copies of the class. */
export function isWrongCredential(error: unknown) {
  return error instanceof Error && error.name === "AccountError" && Boolean((error as AccountError).wrongCredential);
}

export type User = { id: string; username: string; role: Role; createdAt: number; lastLoginAt: number | null; lastSeenAt: number | null; disabled: boolean; twoFactor: boolean };
export type Session = { id: string; userId: string | null; recovery: boolean; persistent: boolean; createdAt: number; lastSeenAt: number; expiresAt: number; userAgent: string; ip: string };
type Invite = { id: string; kind: "invite" | "reset"; role: Role | null; userId: string | null; username?: string; createdBy: string; createdAt: number; expiresAt: number };
type AuditEntry = { id: number; at: number; actor: string; message: string };

const HOUR = 60 * 60 * 1000;
export const SESSION_TTL = { persistent: 14 * 24 * HOUR, browser: 12 * HOUR, recovery: HOUR };
/** Persistent sessions slide while used, but never past this age: a stolen cookie can't live forever. */
export const SESSION_MAX_AGE = 30 * 24 * HOUR;
export const INVITE_TTL = 24 * HOUR;
/** Time to enter the code after a correct password, and wrong codes allowed in that time. */
export const CHALLENGE_TTL = 5 * 60 * 1000;
export const CHALLENGE_ATTEMPTS = 5;
// last_seen_at is written at most this often, so polling doesn't turn every request into a write.
const TOUCH_INTERVAL = 60 * 1000;
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;
/** A server's own SFTP password for one account: shown on the server's SFTP tab and kept so it can be shown again. */
export type ServerSftpPassword = { password: string; createdAt: number; lastUsedAt: number | null };

type Row = Record<string, unknown>;
/**
 * Settings that hold reusable credentials, sealed whole with the secret box: offsite destination
 * secrets and index password (lib/offsite-settings.ts), the offsite SSH key (lib/offsite.ts), the
 * Blocky Cloud token and backup keys (lib/cloud.ts), and the SFTP host key (lib/sftp.ts).
 */
export const SEALED_SETTINGS = new Set(["offsite", "offsite-ssh-key", "cloud", "sftp-host-key"]);
/** Sealed values start with "v1."; base32 TOTP secrets and JSON text never do, so older plain values are told apart. */
const isSealed = (value: string) => value.startsWith("v1.");

function toUser(row: Row): User {
  return { id: String(row.id), username: String(row.username), role: row.role as Role, createdAt: Number(row.created_at), lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at), lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at), disabled: Boolean(row.disabled), twoFactor: Boolean(row.totp_secret) };
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
  private readonly box: SecretBox;
  private readonly unreadableLogged = new Set<string>();

  constructor(db: DatabaseSync, now: () => number = Date.now, box: SecretBox = SecretBox.random()) {
    this.db = db;
    this.now = now;
    this.box = box;
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
    // Two-factor sign-in, added later: the active secret, one being set up, and the last code's step.
    const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => String(column.name));
    for (const column of ["totp_secret TEXT", "totp_pending TEXT", "totp_last_step INTEGER"]) {
      if (!userColumns.includes(column.split(" ")[0])) db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        PRIMARY KEY (user_id, code_hash)
      );
      CREATE TABLE IF NOT EXISTS login_challenges (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        persistent INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL
      );
      -- SSH keys and account-wide SFTP passwords, before each server got its own password.
      DROP TABLE IF EXISTS sftp_credentials;
      CREATE TABLE IF NOT EXISTS sftp_server_passwords (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL,
        id TEXT NOT NULL UNIQUE,
        password_sealed TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        PRIMARY KEY (user_id, server_id)
      );
    `);
    this.sealPlainSecrets();
  }

  /** Seals TOTP secrets and credential settings saved as plain text by earlier versions. Runs once per start. */
  private sealPlainSecrets() {
    this.transaction(() => {
      for (const column of ["totp_secret", "totp_pending"]) {
        for (const row of this.db.prepare(`SELECT id, ${column} AS value FROM users WHERE ${column} IS NOT NULL`).all()) {
          if (!isSealed(String(row.value))) this.db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(this.box.seal(String(row.value)), String(row.id));
        }
      }
      for (const row of this.db.prepare("SELECT key, value FROM settings").all()) {
        if (SEALED_SETTINGS.has(String(row.key)) && !isSealed(String(row.value))) this.db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(this.box.seal(String(row.value)), String(row.key));
      }
    });
  }

  /** A secret as saved: opened when sealed (undefined when the key can't open it), or an older plain value as is. */
  private openSecret(value: string) {
    return isSealed(value) ? this.box.open(value) : value;
  }

  /** The user's TOTP secret, or undefined (logged) when panel/secret.key no longer opens it. */
  private totpSecret(userId: string, value: unknown) {
    const secret = this.openSecret(String(value));
    if (secret === undefined) console.error(`Blocky: user ${userId}'s two-factor secret can't be decrypted with panel/secret.key (was the key file replaced?). They can sign in with a recovery code, or an admin can turn their two-factor sign-in off.`);
    return secret;
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

  findUser(username: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username);
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
    if (!row || !valid) return undefined;
    // Read again after the slow check: the account may have been disabled, its password changed, or
    // two-factor turned on meanwhile, and the caller must act on how it is now.
    const fresh = this.db.prepare("SELECT * FROM users WHERE id = ?").get(String(row.id));
    if (!fresh || fresh.disabled || fresh.password_hash !== row.password_hash) return undefined;
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(this.now(), String(row.id));
    return toUser(fresh);
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

  /** Confirms a signed-in user's password before a sensitive change (turning two-factor off, new codes). */
  async checkPassword(userId: string, password: string) {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    if (!row) throw new AccountError(404, "User not found.");
    if (!(await verifyPassword(password, String(row.password_hash)))) throw new AccountError(400, "Your password is incorrect.", "password", true);
  }

  /** Sets a new password and revokes what the old one may have let someone set up (see revokeCredentials). */
  async changePassword(userId: string, current: string, next: string, keepSessionId?: string) {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    if (!row) throw new AccountError(404, "User not found.");
    // Checked first, so a too-short new password isn't counted as a wrong current one.
    assertPassword(next);
    if (!(await verifyPassword(current, String(row.password_hash)))) throw new AccountError(400, "Your current password is incorrect.", "current", true);
    const hash = await hashPassword(next);
    this.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      this.revokeCredentials(userId, keepSessionId);
    });
  }

  /**
   * After a password change or reset: ends other sessions, sign-ins waiting for a code, unused reset
   * links, and the account's SFTP passwords (each server makes a new one when its SFTP tab is next
   * opened, and SFTP sessions using an old one end).
   */
  private revokeCredentials(userId: string, keepSessionId?: string) {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId || "");
    this.db.prepare("DELETE FROM login_challenges WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM invites WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL").run(userId);
    this.db.prepare("DELETE FROM sftp_server_passwords WHERE user_id = ?").run(userId);
  }

  // ---- Two-factor sign-in (authenticator app codes) ----

  /** Starts setup: a new secret waits for a first correct code before it's turned on. */
  beginTwoFactor(userId: string) {
    const row = this.db.prepare("SELECT username, totp_secret FROM users WHERE id = ?").get(userId);
    if (!row) throw new AccountError(404, "User not found.");
    if (row.totp_secret) throw new AccountError(409, "Two-factor sign-in is already on. Turn it off first to set up a new device.");
    const secret = newTotpSecret();
    this.db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(this.box.seal(secret), userId);
    return { secret, username: String(row.username) };
  }

  /**
   * Turns two-factor sign-in on once the app shows a correct code, and returns fresh recovery codes.
   * Other sessions end: they were opened with the password alone.
   */
  confirmTwoFactor(userId: string, code: string, keepSessionId?: string) {
    const row = this.db.prepare("SELECT totp_pending FROM users WHERE id = ?").get(userId);
    const pending = row?.totp_pending ? this.totpSecret(userId, row.totp_pending) : undefined;
    if (!pending) throw new AccountError(409, "Start setting up two-factor sign-in first.");
    const step = verifyTotp(pending, code, this.now());
    if (step === null) throw new AccountError(400, "That code isn't right. Check the time on your phone is set automatically, and enter the newest code.", "code");
    return this.transaction(() => {
      this.db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?").run(step, userId);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId || "");
      return this.replaceRecoveryCodes(userId);
    });
  }

  disableTwoFactor(userId: string) {
    if (!this.getUser(userId)) throw new AccountError(404, "User not found.");
    this.transaction(() => {
      this.db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE id = ?").run(userId);
      this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM login_challenges WHERE user_id = ?").run(userId);
    });
  }

  /** New recovery codes; the old ones stop working. */
  regenerateRecoveryCodes(userId: string) {
    if (!this.getUser(userId)?.twoFactor) throw new AccountError(409, "Two-factor sign-in isn't on.");
    return this.transaction(() => this.replaceRecoveryCodes(userId));
  }

  recoveryCodesLeft(userId: string) {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as { n: number }).n);
  }

  private replaceRecoveryCodes(userId: string) {
    const codes = newRecoveryCodes();
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    const insert = this.db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const code of codes) insert.run(userId, hashToken(code));
    return codes;
  }

  /**
   * After a correct password for a two-factor account: a short-lived token for the code step. Only
   * the newest one per account works, so repeating the password can't open many at once.
   */
  createLoginChallenge(userId: string, persistent: boolean) {
    const token = newToken();
    this.db.prepare("DELETE FROM login_challenges WHERE expires_at <= ? OR user_id = ?").run(this.now(), userId);
    this.db.prepare("INSERT INTO login_challenges (id, token_hash, user_id, persistent, expires_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), hashToken(token), userId, persistent ? 1 : 0, this.now() + CHALLENGE_TTL);
    return token;
  }

  /** The account a live sign-in challenge belongs to, so wrong codes can be counted against it. */
  loginChallengeUser(token: string): User | undefined {
    const row = this.db.prepare("SELECT user_id FROM login_challenges WHERE token_hash = ? AND expires_at > ?").get(hashToken(token), this.now());
    return row ? this.getUser(String(row.user_id)) : undefined;
  }

  /**
   * Checks the code for a sign-in in progress: an authenticator code (never the same one twice) or
   * an unused recovery code. The challenge is used up on success, or after too many wrong codes.
   */
  completeLoginChallenge(token: string, code: string) {
    // Failures are returned, not thrown, inside the transaction: throwing would roll back the
    // attempt count (and the deletion of a spent challenge) along with everything else.
    const outcome = this.transaction((): { error: AccountError } | { user: User; persistent: boolean; usedRecoveryCode: boolean; recoveryCodesLeft: number } => {
      const challenge = this.db.prepare("SELECT * FROM login_challenges WHERE token_hash = ?").get(hashToken(token));
      if (!challenge || Number(challenge.expires_at) <= this.now()) {
        if (challenge) this.db.prepare("DELETE FROM login_challenges WHERE id = ?").run(String(challenge.id));
        return { error: new AccountError(410, "That sign-in timed out. Enter your password again.") };
      }
      const userId = String(challenge.user_id);
      const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      if (!row || row.disabled || !row.totp_secret) {
        this.db.prepare("DELETE FROM login_challenges WHERE id = ?").run(String(challenge.id));
        return { error: new AccountError(410, "That sign-in is no longer valid. Enter your password again.") };
      }
      let usedRecoveryCode = false;
      // A secret the key can't open accepts no authenticator code; recovery codes still work.
      const secret = this.totpSecret(userId, row.totp_secret);
      const step = secret === undefined ? null : verifyTotp(secret, code, this.now(), row.totp_last_step == null ? -1 : Number(row.totp_last_step));
      if (step !== null) this.db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, userId);
      else {
        const recovery = normalizeRecoveryCode(code);
        const used = recovery ? this.db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(this.now(), userId, hashToken(recovery)) : undefined;
        usedRecoveryCode = Boolean(used?.changes);
      }
      if (step === null && !usedRecoveryCode) {
        const attempts = Number(challenge.attempts) + 1;
        if (attempts >= CHALLENGE_ATTEMPTS) {
          this.db.prepare("DELETE FROM login_challenges WHERE id = ?").run(String(challenge.id));
          return { error: new AccountError(410, "Too many wrong codes. Enter your password again.", undefined, true) };
        }
        this.db.prepare("UPDATE login_challenges SET attempts = ? WHERE id = ?").run(attempts, String(challenge.id));
        return { error: new AccountError(401, `That code isn't right. ${CHALLENGE_ATTEMPTS - attempts} tr${CHALLENGE_ATTEMPTS - attempts === 1 ? "y" : "ies"} left.`, "code", true) };
      }
      this.db.prepare("DELETE FROM login_challenges WHERE id = ?").run(String(challenge.id));
      return { user: toUser(row), persistent: Boolean(challenge.persistent), usedRecoveryCode, recoveryCodesLeft: this.recoveryCodesLeft(userId) };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome;
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
   * deleted users are removed. Persistent sessions slide forward while in use, up to
   * SESSION_MAX_AGE after they were opened. Recovery sessions
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
    if (session.expiresAt <= now || now - session.createdAt >= SESSION_MAX_AGE || recoveryRevoked || (session.userId && (!user || user.disabled)) || (!session.userId && !session.recovery)) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      return undefined;
    }
    if (now - session.lastSeenAt >= TOUCH_INTERVAL) {
      const expiresAt = session.persistent ? Math.min(now + SESSION_TTL.persistent, session.createdAt + SESSION_MAX_AGE) : session.expiresAt;
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

  /**
   * Uses an invite (creating the account) or a reset link (setting a new password). Single use. A
   * reset of a two-factor account returns a login challenge rather than counting as a sign-in:
   * whoever holds the link still needs the account's code.
   */
  async acceptInvite(token: string, password: string, username?: string): Promise<{ user: User; challenge?: string }> {
    const expired = () => new AccountError(410, "This link has expired or was already used. Ask an admin for a new one.");
    const invite = this.inviteForToken(token);
    if (!invite) throw expired();
    assertPassword(password);
    if (invite.kind === "invite") {
      assertUsername(username || "");
      if (this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(username!)) throw new AccountError(409, "That username is taken.", "username");
    }
    // Claimed before the slow hash, so a burst of requests with one link can't all hash. Released if anything after fails.
    const claimed = this.db.prepare("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(this.now(), invite.id, this.now());
    if (!claimed.changes) throw expired();
    try {
      const hash = await hashPassword(password);
      return this.transaction(() => {
        if (invite.kind === "invite") return { user: this.insertUser(username!, hash, invite.role!) };
        const user = this.getUser(invite.userId!);
        if (!user) throw new AccountError(410, "This account no longer exists.");
        this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
        this.revokeCredentials(user.id);
        return { user, challenge: user.twoFactor ? this.createLoginChallenge(user.id, true) : undefined };
      });
    } catch (error) {
      this.db.prepare("UPDATE invites SET used_at = NULL WHERE id = ?").run(invite.id);
      throw error;
    }
  }

  // ---- SFTP: who may sign in, and whether a session may go on ----
  // The account password never works for SFTP: an SFTP app can't ask for a two-factor code, so it
  // would let someone who learned the password skip two-factor sign-in. Each server has its own.

  /** The account an SFTP login names, when it may use SFTP at all: an active admin (files are admin-only). */
  sftpAccount(username: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!row) return undefined;
    const user = toUser(row);
    return user.role === "admin" && !user.disabled ? user : undefined;
  }

  /** Whether a signed-in SFTP session may continue: its password wasn't re-rolled and its user is still an active admin. */
  sftpCredentialActive(id: string) {
    const row = this.db.prepare("SELECT users.role, users.disabled FROM sftp_server_passwords JOIN users ON users.id = sftp_server_passwords.user_id WHERE sftp_server_passwords.id = ?").get(id);
    return Boolean(row && row.role === "admin" && !row.disabled);
  }

  touchSftpCredential(id: string) {
    this.db.prepare("UPDATE sftp_server_passwords SET last_used_at = ? WHERE id = ?").run(this.now(), id);
  }

  // ---- Each server's own SFTP password ----
  // One per account and server, made on first look and shown on the server's SFTP tab. It only opens
  // that server. It's kept encrypted, not hashed, so it can be shown again; re-rolling replaces it and
  // ends sessions that used the old one (their credential ID changes).

  /** This account's password for the server, made now if there isn't one yet. */
  serverSftpPassword(userId: string, serverId: string): ServerSftpPassword {
    if (!this.getUser(userId)) throw new AccountError(404, "User not found.");
    const row = this.db.prepare("SELECT * FROM sftp_server_passwords WHERE user_id = ? AND server_id = ?").get(userId, serverId);
    const password = row ? this.box.open(String(row.password_sealed)) : undefined;
    // A password sealed with a key that's gone (a restored database without its key file) is replaced.
    if (!row || password === undefined) return this.rerollServerSftpPassword(userId, serverId);
    return { password, createdAt: Number(row.created_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at) };
  }

  /** A new password for the server; the old one stops working at once. */
  rerollServerSftpPassword(userId: string, serverId: string): ServerSftpPassword {
    if (!this.getUser(userId)) throw new AccountError(404, "User not found.");
    const password = newToken();
    const createdAt = this.now();
    this.db.prepare(`INSERT INTO sftp_server_passwords (user_id, server_id, id, password_sealed, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, server_id) DO UPDATE SET id = excluded.id, password_sealed = excluded.password_sealed, created_at = excluded.created_at, last_used_at = NULL`)
      .run(userId, serverId, randomUUID(), this.box.seal(password), createdAt);
    return { password, createdAt, lastUsedAt: null };
  }

  /** The credential ID when `password` is this account's password for the server. */
  serverSftpPasswordCredential(userId: string, serverId: string, password: string): string | undefined {
    const row = this.db.prepare("SELECT id, password_sealed FROM sftp_server_passwords WHERE user_id = ? AND server_id = ?").get(userId, serverId);
    const stored = row ? this.box.open(String(row.password_sealed)) : undefined;
    return stored !== undefined && sameSecret(stored, password) ? String(row!.id) : undefined;
  }

  /** Forgets every account's password for a server that's been removed. */
  deleteServerSftpPasswords(serverId: string) {
    this.db.prepare("DELETE FROM sftp_server_passwords WHERE server_id = ?").run(serverId);
  }

  // ---- Panel settings (JSON values, e.g. offsite backups) ----

  /**
   * A setting's value. One in SEALED_SETTINGS that panel/secret.key can't open (the key file was
   * replaced) reads as unset, so it can be set up again; settingUnreadable tells the two apart.
   */
  getSetting<T>(key: string): T | undefined {
    const text = this.settingText(key);
    if (text === null) {
      if (!this.unreadableLogged.has(key)) console.error(`Blocky: the saved "${key}" setting can't be decrypted with panel/secret.key (was the key file replaced?). It's treated as unset until it's saved again.`);
      this.unreadableLogged.add(key);
    }
    return text ? JSON.parse(text) as T : undefined;
  }

  /** Whether a setting is saved but sealed with a key panel/secret.key isn't. */
  settingUnreadable(key: string) {
    return this.settingText(key) === null;
  }

  /** The stored JSON text, undefined when unset, or null when it's sealed with another key. */
  private settingText(key: string) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return undefined;
    return SEALED_SETTINGS.has(key) ? this.openSecret(String(row.value)) ?? null : String(row.value);
  }

  /** Stores a value, or removes the setting when `value` is undefined. */
  setSetting(key: string, value: unknown) {
    if (value === undefined) { this.db.prepare("DELETE FROM settings WHERE key = ?").run(key); return; }
    const text = JSON.stringify(value);
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, SEALED_SETTINGS.has(key) ? this.box.seal(text) : text);
  }

  // ---- Audit log (account events; server activity lives in the control state) ----

  audit(actor: string, message: string) {
    this.db.prepare("INSERT INTO audit (at, actor, message) VALUES (?, ?, ?)").run(this.now(), actor.slice(0, 64), message.slice(0, 300));
    this.db.prepare("DELETE FROM audit WHERE id <= (SELECT MAX(id) - 5000 FROM audit)").run();
  }

  listAudit(limit = 50): AuditEntry[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit).map((row) => ({ id: Number(row.id), at: Number(row.at), actor: String(row.actor), message: String(row.message) }));
  }
}
