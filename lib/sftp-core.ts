import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, stat, unlink, utimes, type FileHandle } from "node:fs/promises";
import path from "node:path";
import ssh2 from "ssh2";
import type { AuthContext, Connection, FileEntry, SFTPWrapper } from "ssh2";
import { anchorDirectory, anchorParent, type AnchoredDirectory } from "./anchored-paths.ts";
import { HttpError } from "./errors.ts";

/**
 * The SFTP server behind the file manager's "Connect with SFTP". Each session is confined to one
 * server's data folder and every request goes through the same anchored paths as the file manager:
 * each path component is opened without following links, and the operation runs on the held
 * descriptor, so the Minecraft container (which can write to that folder) can't redirect a transfer
 * with a symlink. Links are never listed, followed, or created. No Next.js imports, so tests drive it
 * with a real SFTP client.
 */

const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
const OP_UNSUPPORTED = 8;

// Not defined on Windows, where the dev server may run.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const GAME_UID = 1000;
const GAME_GID = 1000;

export type SftpUser = {
  /** The panel account, for the activity log. */
  username: string;
  serverId: string;
  /** The server's data folder: the session's "/". */
  root: string;
  /** Checked again during the session, so removing a key or an admin role ends access. */
  stillAllowed: () => boolean | Promise<boolean>;
};

export type SftpAuthenticator = {
  /** The user for a login name and password, or undefined. Throttling is the caller's. */
  password: (login: string, password: string, client: string) => Promise<SftpUser | undefined>;
  /** The user when this public key is registered for the login, or undefined. The signature is checked here. */
  publicKey: (login: string, key: Buffer, client: string) => Promise<SftpUser | undefined>;
  /** A key was offered with a bad signature. */
  failed?: (login: string, client: string) => void;
};

export type SessionSummary = { uploaded: string[]; deleted: string[]; created: string[]; renamed: string[] };

export type SftpLimits = { connections: number; perUser: number; handles: number; idleMs: number };
export const DEFAULT_LIMITS: SftpLimits = { connections: 48, perUser: 8, handles: 64, idleMs: 30 * 60_000 };

const READ_CHUNK = 64 * 1024;
const DIRECTORY_BATCH = 256;
const ALLOWED_CACHE_MS = 5000;

/** "alex.953dfb01" -> the account and the server it wants. Usernames may contain dots, so the last one splits. */
export function splitSftpLogin(login: string) {
  const dot = login.lastIndexOf(".");
  if (dot <= 0 || dot === login.length - 1) return undefined;
  const account = login.slice(0, dot);
  const server = login.slice(dot + 1);
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(account) || !/^[a-zA-Z0-9-]{1,64}$/.test(server)) return undefined;
  return { account, server };
}

/** A client path as a path relative to the session's root. ".." never climbs above it, like a chroot. */
export function sftpRelative(requested: string) {
  if (requested.includes("\0")) throw new SftpDenied();
  const absolute = path.posix.resolve("/", requested.replace(/\\/g, "/"));
  return absolute === "/" ? "" : absolute.slice(1);
}

class SftpDenied extends Error { constructor(message = "Permission denied") { super(message); this.name = "SftpDenied"; } }
class SftpFailure extends Error { constructor(message: string) { super(message); this.name = "SftpFailure"; } }

/** Status code and a fixed message: nothing from the server's own paths (like /proc/self/fd) reaches the client. */
function statusFor(error: unknown): [number, string] {
  if (error instanceof SftpDenied || error instanceof HttpError) return [STATUS_CODE.PERMISSION_DENIED, "Permission denied"];
  if (error instanceof SftpFailure) return [STATUS_CODE.FAILURE, error.message];
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOENT": return [STATUS_CODE.NO_SUCH_FILE, "No such file or directory"];
    case "EACCES": case "EPERM": case "ELOOP": case "ENXIO": return [STATUS_CODE.PERMISSION_DENIED, "Permission denied"];
    case "EEXIST": return [STATUS_CODE.FAILURE, "Already exists"];
    case "ENOTEMPTY": return [STATUS_CODE.FAILURE, "Directory not empty"];
    case "ENOTDIR": return [STATUS_CODE.FAILURE, "Not a directory"];
    case "EISDIR": return [STATUS_CODE.FAILURE, "Is a directory"];
    case "ENOSPC": return [STATUS_CODE.FAILURE, "No space left on the server's disk"];
    default: return [STATUS_CODE.FAILURE, "Operation failed"];
  }
}

function attrsOf(info: Stats) {
  return { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An `ls -l` style line; clients show it when they don't read the attributes themselves. */
function longname(name: string, info: Stats) {
  const type = info.isDirectory() ? "d" : "-";
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1].map((bit, index) => (info.mode & bit ? "rwx"[index % 3] : "-")).join("");
  const date = info.mtime;
  const stamp = `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2)} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `${type}${bits} 1 ${info.uid} ${info.gid} ${String(info.size).padStart(10)} ${stamp} ${name}`;
}

function openFlags(flags: number) {
  const read = Boolean(flags & OPEN_MODE.READ);
  const write = Boolean(flags & OPEN_MODE.WRITE);
  let result = read && write ? constants.O_RDWR : write ? constants.O_WRONLY : constants.O_RDONLY;
  if (flags & OPEN_MODE.APPEND) result |= constants.O_APPEND;
  if (flags & OPEN_MODE.CREAT) result |= constants.O_CREAT;
  if (flags & OPEN_MODE.TRUNC) result |= constants.O_TRUNC;
  if (flags & OPEN_MODE.EXCL) result |= constants.O_EXCL;
  // O_NONBLOCK: a FIFO planted by the game would otherwise block the open forever.
  return result | NOFOLLOW | NONBLOCK;
}

/** Hands something the panel (running as root) just created to the game's user. */
async function giveToGame(handle: FileHandle, info: Stats) {
  if (typeof process.getuid === "function" && info.uid === process.getuid() && info.uid !== GAME_UID) await handle.chown(GAME_UID, GAME_GID).catch(() => undefined);
}

type FileState = { kind: "file"; file: FileHandle; path: string; wrote: boolean };
type DirectoryState = { kind: "dir"; dir: AnchoredDirectory; path: string; pending?: FileEntry[] };
type HandleState = FileState | DirectoryState;

type Attrs = Partial<{ mode: number; size: number; atime: number; mtime: number }>;

/** Applies what SETSTAT asks for that's safe: permission bits (never setuid), times, and size. Owners are ignored. */
async function applyAttrs(target: { handle?: FileHandle; path?: string }, attrs: Attrs) {
  if (attrs.mode !== undefined) {
    const mode = attrs.mode & 0o777;
    if (target.handle) await target.handle.chmod(mode); else if (target.path) await chmod(target.path, mode);
  }
  if (attrs.atime !== undefined || attrs.mtime !== undefined) {
    const now = Date.now() / 1000;
    const atime = attrs.atime ?? attrs.mtime ?? now;
    const mtime = attrs.mtime ?? attrs.atime ?? now;
    if (target.handle) await target.handle.utimes(atime, mtime); else if (target.path) await utimes(target.path, atime, mtime);
  }
  if (attrs.size !== undefined) {
    if (!target.handle) throw new SftpFailure("Open the file to change its size");
    await target.handle.truncate(attrs.size);
  }
}

/** Serves SFTP requests for one signed-in session. Returns a function that closes everything it holds. */
function serve(sftp: SFTPWrapper, user: SftpUser, summary: SessionSummary, limits: SftpLimits, touch: () => void, revoke: () => void) {
  const handles = new Map<number, HandleState>();
  let nextHandle = 1;
  let allowedAt = 0;
  let allowed = true;

  async function stillAllowed() {
    if (Date.now() - allowedAt < ALLOWED_CACHE_MS) return allowed;
    allowed = Boolean(await user.stillAllowed());
    allowedAt = Date.now();
    return allowed;
  }

  function note(list: string[], entry: string) {
    if (list.length < 200 && !list.includes(entry)) list.push(entry);
  }

  // Requests are handled one at a time, in the order they arrive, so replies go out in that order
  // too. The protocol allows any order, but WinSCP drops the connection ("Received
  // SSH2_MSG_CHANNEL_DATA for nonexistent channel 0") when replies to its pipelined writes overtake
  // each other. Each request is small (at most one read or write of a chunk), so this costs little.
  let queue: Promise<void> = Promise.resolve();
  function run(reqid: number, work: () => Promise<void>) {
    touch();
    queue = queue.then(async () => {
      try {
        if (!(await stillAllowed())) { sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, "Access was revoked"); revoke(); return; }
        await work();
      } catch (error) {
        const [code, message] = statusFor(error);
        try { sftp.status(reqid, code, message); } catch { /* channel closed */ }
      }
    });
  }

  function addHandle(state: HandleState) {
    if (handles.size >= limits.handles) throw new SftpFailure("Too many open files in this session");
    const id = nextHandle++;
    handles.set(id, state);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id);
    return buffer;
  }

  function handleFor(buffer: Buffer) {
    return buffer.length === 4 ? handles.get(buffer.readUInt32BE(0)) : undefined;
  }

  function fileFor(buffer: Buffer) {
    const state = handleFor(buffer);
    if (state?.kind !== "file") throw new SftpFailure("Invalid handle");
    return state;
  }

  /** The parent directory held open, and the final name; the root itself has no parent. */
  async function parentOf(relative: string) {
    if (!relative) throw new SftpDenied();
    return anchorParent(user.root, relative);
  }

  async function statPath(relative: string) {
    if (!relative) {
      const directory = await anchorDirectory(user.root, "");
      try { return await stat(directory.path); } finally { await directory.close(); }
    }
    const parent = await parentOf(relative);
    try {
      const info = await lstat(path.join(parent.path, parent.name));
      // Links are never shown or followed, so they look like they aren't there.
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw Object.assign(new Error("hidden"), { code: "ENOENT" });
      return info;
    } finally { await parent.close(); }
  }

  sftp.on("REALPATH", (reqid, requested) => run(reqid, async () => {
    const absolute = `/${sftpRelative(requested)}`;
    sftp.name(reqid, [{ filename: absolute, longname: absolute, attrs: {} as never }]);
  }));

  sftp.on("OPEN", (reqid, filename, flags) => run(reqid, async () => {
    const relative = sftpRelative(filename);
    const parent = await parentOf(relative);
    let file: FileHandle;
    try { file = await open(path.join(parent.path, parent.name), openFlags(flags), 0o660); }
    finally { await parent.close(); }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new SftpFailure("Not a regular file");
      if (flags & OPEN_MODE.CREAT) await giveToGame(file, info);
      sftp.handle(reqid, addHandle({ kind: "file", file, path: relative, wrote: false }));
    } catch (error) { await file.close(); throw error; }
  }));

  sftp.on("READ", (reqid, handle, offset, length) => run(reqid, async () => {
    const state = fileFor(handle);
    const buffer = Buffer.alloc(Math.min(length, READ_CHUNK));
    const { bytesRead } = await state.file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) sftp.status(reqid, STATUS_CODE.EOF);
    else sftp.data(reqid, buffer.subarray(0, bytesRead));
  }));

  sftp.on("WRITE", (reqid, handle, offset, data) => run(reqid, async () => {
    const state = fileFor(handle);
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await state.file.write(data, written, data.length - written, offset + written);
      written += bytesWritten;
    }
    state.wrote = true;
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("FSTAT", (reqid, handle) => run(reqid, async () => {
    const state = handleFor(handle);
    if (!state) throw new SftpFailure("Invalid handle");
    sftp.attrs(reqid, attrsOf(state.kind === "file" ? await state.file.stat() : await stat(state.dir.path)));
  }));

  sftp.on("FSETSTAT", (reqid, handle, attrs) => run(reqid, async () => {
    const state = handleFor(handle);
    if (!state) throw new SftpFailure("Invalid handle");
    if (state.kind === "file") await applyAttrs({ handle: state.file }, attrs);
    else await applyAttrs({ path: state.dir.path }, { ...attrs, size: undefined });
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("SETSTAT", (reqid, requested, attrs) => run(reqid, async () => {
    const relative = sftpRelative(requested);
    if (!relative) { sftp.status(reqid, STATUS_CODE.OK); return; }
    const parent = await parentOf(relative);
    try {
      const target = path.join(parent.path, parent.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new SftpDenied();
      if (info.isDirectory()) {
        // A directory can't be opened as a file handle on Windows; on Linux its descriptor is used.
        if (process.platform !== "linux") await applyAttrs({ path: target }, { ...attrs, size: undefined });
        else {
          const directory = await open(target, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
          try { await applyAttrs({ handle: directory }, { ...attrs, size: undefined }); } finally { await directory.close(); }
        }
      } else if (info.isFile()) {
        const file = await open(target, (attrs.size !== undefined ? constants.O_WRONLY : constants.O_RDONLY) | NOFOLLOW | NONBLOCK);
        try { await applyAttrs({ handle: file }, attrs); } finally { await file.close(); }
      } else throw new SftpDenied();
    } finally { await parent.close(); }
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("CLOSE", (reqid, handle) => run(reqid, async () => {
    const state = handleFor(handle);
    if (!state) throw new SftpFailure("Invalid handle");
    handles.delete(handle.readUInt32BE(0));
    if (state.kind === "file") {
      await state.file.close();
      if (state.wrote) note(summary.uploaded, state.path);
    } else await state.dir.close();
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("OPENDIR", (reqid, requested) => run(reqid, async () => {
    const relative = sftpRelative(requested);
    const dir = await anchorDirectory(user.root, relative);
    try {
      if (!(await stat(dir.path)).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      sftp.handle(reqid, addHandle({ kind: "dir", dir, path: relative }));
    } catch (error) { await dir.close(); throw error; }
  }));

  sftp.on("READDIR", (reqid, handle) => run(reqid, async () => {
    const state = handleFor(handle);
    if (state?.kind !== "dir") throw new SftpFailure("Invalid handle");
    if (!state.pending) {
      const entries: FileEntry[] = [];
      for (const entry of await readdir(state.dir.path, { withFileTypes: true })) {
        // Links and special files are left out, like in the file manager.
        if (!entry.isFile() && !entry.isDirectory()) continue;
        const info = await lstat(path.join(state.dir.path, entry.name)).catch(() => undefined);
        if (!info || (!info.isFile() && !info.isDirectory())) continue;
        entries.push({ filename: entry.name, longname: longname(entry.name, info), attrs: attrsOf(info) });
      }
      state.pending = entries;
    }
    const batch = state.pending.splice(0, DIRECTORY_BATCH);
    if (!batch.length) sftp.status(reqid, STATUS_CODE.EOF);
    else sftp.name(reqid, batch);
  }));

  sftp.on("LSTAT", (reqid, requested) => run(reqid, async () => { sftp.attrs(reqid, attrsOf(await statPath(sftpRelative(requested)))); }));
  sftp.on("STAT", (reqid, requested) => run(reqid, async () => { sftp.attrs(reqid, attrsOf(await statPath(sftpRelative(requested)))); }));

  sftp.on("MKDIR", (reqid, requested) => run(reqid, async () => {
    const relative = sftpRelative(requested);
    const parent = await parentOf(relative);
    try {
      const target = path.join(parent.path, parent.name);
      await mkdir(target);
      // Ownership through the new directory's own descriptor; chown(path) would follow a swapped link.
      if (process.platform === "linux") {
        const created = await open(target, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
        try {
          await giveToGame(created, await created.stat());
          await created.chmod(0o770).catch(() => undefined);
        } finally { await created.close(); }
      }
    } finally { await parent.close(); }
    note(summary.created, relative);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("RMDIR", (reqid, requested) => run(reqid, async () => {
    const relative = sftpRelative(requested);
    const parent = await parentOf(relative);
    // rmdir refuses a link (ENOTDIR) and a non-empty directory; clients delete trees file by file.
    try { await rmdir(path.join(parent.path, parent.name)); } finally { await parent.close(); }
    note(summary.deleted, `${relative}/`);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("REMOVE", (reqid, requested) => run(reqid, async () => {
    const relative = sftpRelative(requested);
    const parent = await parentOf(relative);
    try {
      const target = path.join(parent.path, parent.name);
      if ((await lstat(target)).isDirectory()) throw Object.assign(new Error("directory"), { code: "EISDIR" });
      // unlink removes a link itself, never what it points to.
      await unlink(target);
    } finally { await parent.close(); }
    note(summary.deleted, relative);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on("RENAME", (reqid, from, to) => run(reqid, async () => {
    const source = sftpRelative(from);
    const destination = sftpRelative(to);
    const fromParent = await parentOf(source);
    try {
      const toParent = await parentOf(destination);
      try {
        const target = path.join(toParent.path, toParent.name);
        // SFTP version 3 renames never replace an existing entry.
        if (await lstat(target).catch(() => undefined)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        await rename(path.join(fromParent.path, fromParent.name), target);
      } finally { await toParent.close(); }
    } finally { await fromParent.close(); }
    note(summary.renamed, `${source} -> ${destination}`);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  // Links are never read or made: the game could use one to point the panel elsewhere.
  sftp.on("READLINK", (reqid) => run(reqid, async () => { sftp.status(reqid, OP_UNSUPPORTED, "Links aren't supported"); }));
  sftp.on("SYMLINK", (reqid) => run(reqid, async () => { sftp.status(reqid, OP_UNSUPPORTED, "Links aren't supported"); }));
  sftp.on("EXTENDED", (reqid) => { try { sftp.status(reqid, OP_UNSUPPORTED, "Not supported"); } catch { /* closed */ } });

  return async () => {
    for (const state of handles.values()) {
      if (state.kind === "file") {
        await state.file.close().catch(() => undefined);
        if (state.wrote) note(summary.uploaded, state.path);
      } else await state.dir.close().catch(() => undefined);
    }
    handles.clear();
  };
}

/**
 * An SSH server that only offers SFTP. Password and public-key sign-in go through `auth`; shells,
 * commands, and port forwarding are refused. The caller calls listen() and handles its errors.
 */
export function createSftpServer(options: { hostKey: string | Buffer; auth: SftpAuthenticator; limits?: Partial<SftpLimits>; onSessionEnd?: (user: SftpUser, summary: SessionSummary) => void; ident?: string }) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const perUser = new Map<string, number>();
  let connections = 0;

  const server = new ssh2.Server({ hostKeys: [options.hostKey], ident: options.ident ?? "BlockyPanel", keepaliveInterval: 15_000, keepaliveCountMax: 4 }, (client: Connection, info) => {
    connections += 1;
    const address = info.ip || "unknown";
    let user: SftpUser | undefined;
    let counted = false;
    let closeHandles: (() => Promise<void>) | undefined;
    const summary: SessionSummary = { uploaded: [], deleted: [], created: [], renamed: [] };
    let idle: NodeJS.Timeout | undefined;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => client.end(), limits.idleMs); idle.unref?.(); };
    touch();

    client.on("error", () => undefined);
    client.on("close", () => {
      clearTimeout(idle);
      connections -= 1;
      if (user && counted) {
        const left = (perUser.get(user.username) || 1) - 1;
        if (left > 0) perUser.set(user.username, left); else perUser.delete(user.username);
      }
      void (async () => {
        await closeHandles?.();
        if (user && (summary.uploaded.length || summary.deleted.length || summary.created.length || summary.renamed.length)) options.onSessionEnd?.(user, summary);
      })();
    });
    if (connections > limits.connections) { client.end(); return; }

    client.on("authentication", (context: AuthContext) => {
      void (async () => {
        try {
          if (context.method === "password") {
            const found = await options.auth.password(context.username, context.password, address);
            if (found) { user = found; context.accept(); } else context.reject(["publickey", "password"]);
            return;
          }
          if (context.method === "publickey") {
            const found = await options.auth.publicKey(context.username, context.key.data, address);
            if (!found) { context.reject(["publickey", "password"]); return; }
            // Without a signature the client is asking whether this key would do; it signs next.
            if (!context.signature || !context.blob) { context.accept(); return; }
            const key = ssh2.utils.parseKey(context.key.data);
            if (key instanceof Error || !key.verify(context.blob, context.signature, context.hashAlgo)) {
              options.auth.failed?.(context.username, address);
              context.reject(["publickey", "password"]);
              return;
            }
            user = found;
            context.accept();
            return;
          }
          context.reject(["publickey", "password"]);
        } catch { try { context.reject(); } catch { /* gone */ } }
      })();
    });

    client.on("ready", () => {
      if (!user) { client.end(); return; }
      const active = (perUser.get(user.username) || 0) + 1;
      if (active > limits.perUser) { client.end(); return; }
      perUser.set(user.username, active);
      counted = true;
      const signedIn = user;
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (closeHandles) { rejectSftp?.(); return; } // one SFTP channel per connection
          closeHandles = serve(acceptSftp(), signedIn, summary, limits, touch, () => client.end());
        });
        session.on("shell", (_accept, reject) => reject());
        session.on("exec", (_accept, reject) => reject());
        session.on("pty", (_accept, reject) => reject?.());
        session.on("subsystem", (_accept, reject) => reject());
      });
      client.on("tcpip", (_accept, reject) => reject());
      client.on("request", (_accept, reject) => reject?.());
    });
  });
  return server;
}
