import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import ssh2 from "ssh2";
import type { SFTPWrapper } from "ssh2";
import { createSftpServer, sftpRelative, splitSftpLogin, type SessionSummary, type SftpUser } from "../lib/sftp-core.ts";

// A real ssh2 SFTP client against the panel's SFTP server, over TCP on localhost.

const hostKey = ssh2.utils.generateKeyPairSync("ed25519").private;
const clientKey = ssh2.utils.generateKeyPairSync("ed25519");
const clientBlob = (ssh2.utils.parseKey(clientKey.public) as { getPublicSSH(): Buffer }).getPublicSSH();
const linkTests = process.platform !== "win32";

let folder = "";
let root = "";
let outside = "";
let port = 0;
let allowed = true;
const summaries: SessionSummary[] = [];
const server = createSftpServer({
  hostKey,
  limits: { perUser: 3 },
  auth: {
    password: async (login, password) => (login === "steve.abc12345" && password === "correct-sftp-password" ? user() : undefined),
    publicKey: async (login, key) => (login === "steve.abc12345" && key.equals(clientBlob) ? user() : undefined),
  },
  onSessionEnd: (_user, summary) => summaries.push(summary),
});

function user(): SftpUser {
  return { username: "steve", serverId: "abc12345", root, stillAllowed: () => allowed };
}

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "blocky-sftp-"));
  root = path.join(folder, "data");
  outside = path.join(folder, "outside");
  await mkdir(path.join(root, "plugins"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "server.properties"), "level-name=world\n");
  await writeFile(path.join(outside, "secret.txt"), "outside the server");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
});

type Session = { sftp: SFTPWrapper; end: () => void; closed: Promise<void> };

function connect(credentials: { password?: string; privateKey?: string; username?: string }) {
  return new Promise<Session>((resolve, reject) => {
    const client = new ssh2.Client();
    const closed = new Promise<void>((done) => client.on("close", () => done()));
    client.on("error", reject);
    client.on("ready", () => client.sftp((error, sftp) => (error ? reject(error) : resolve({ sftp, end: () => client.end(), closed }))));
    client.connect({ host: "127.0.0.1", port, username: credentials.username ?? "steve.abc12345", password: credentials.password, privateKey: credentials.privateKey, hostVerifier: () => true, readyTimeout: 5000 });
  });
}

const call = <T>(work: (done: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => work((error, value) => (error ? reject(error) : resolve(value as T))));

const put = (sftp: SFTPWrapper, file: string, content: string) => call<void>((done) => sftp.writeFile(file, content, done));
const get = (sftp: SFTPWrapper, file: string) => call<Buffer>((done) => sftp.readFile(file, done)).then((buffer) => buffer.toString());
const list = (sftp: SFTPWrapper, directory: string) => call<{ filename: string }[]>((done) => sftp.readdir(directory, done)).then((entries) => entries.map((entry) => entry.filename).sort());
const code = (error: unknown) => (error as { code?: number }).code;

test("logins split on the last dot, and paths never climb above the root", () => {
  assert.deepEqual(splitSftpLogin("alex.953dfb01"), { account: "alex", server: "953dfb01" });
  assert.deepEqual(splitSftpLogin("j.doe.953dfb01"), { account: "j.doe", server: "953dfb01" });
  for (const login of ["alex", "alex.", ".953dfb01", "a.953dfb01", "alex.9/3"]) assert.equal(splitSftpLogin(login), undefined, login);
  assert.equal(sftpRelative("/"), "");
  assert.equal(sftpRelative("."), "");
  assert.equal(sftpRelative("../../etc/passwd"), "etc/passwd");
  assert.equal(sftpRelative("/plugins/../server.properties"), "server.properties");
  assert.equal(sftpRelative("plugins\\x.jar"), "plugins/x.jar");
  assert.throws(() => sftpRelative("a\0b"));
});

test("wrong passwords and unknown keys are refused", async () => {
  await assert.rejects(connect({ password: "wrong" }));
  await assert.rejects(connect({ username: "someone.abc12345", password: "correct-sftp-password" }));
  const other = ssh2.utils.generateKeyPairSync("ed25519");
  await assert.rejects(connect({ privateKey: other.private }));
});

test("a key signs in, and files upload, list, download, rename, and delete", async () => {
  const { sftp, end, closed } = await connect({ privateKey: clientKey.private });
  try {
    assert.equal(await call<string>((done) => sftp.realpath(".", done)), "/");
    assert.deepEqual(await list(sftp, "/"), ["plugins", "server.properties"]);
    await put(sftp, "/plugins/hello.yml", "greeting: hi\n");
    assert.equal(await readFile(path.join(root, "plugins", "hello.yml"), "utf8"), "greeting: hi\n");
    assert.equal(await get(sftp, "plugins/hello.yml"), "greeting: hi\n");
    const info = await call<{ size: number; isFile(): boolean }>((done) => sftp.stat("/plugins/hello.yml", done));
    assert.equal(info.size, 13);
    assert.ok(info.isFile());
    await call<void>((done) => sftp.mkdir("/plugins/config", done));
    await call<void>((done) => sftp.rename("/plugins/hello.yml", "/plugins/config/hello.yml", done));
    // Renames never replace an existing entry.
    await put(sftp, "/plugins/other.yml", "x");
    await assert.rejects(call<void>((done) => sftp.rename("/plugins/other.yml", "/plugins/config/hello.yml", done)));
    // A non-empty folder can't be removed in one step; clients delete what's inside first.
    await assert.rejects(call<void>((done) => sftp.rmdir("/plugins/config", done)));
    await call<void>((done) => sftp.unlink("/plugins/config/hello.yml", done));
    await call<void>((done) => sftp.rmdir("/plugins/config", done));
    await assert.rejects(call<void>((done) => sftp.unlink("/plugins", done)), "unlink refuses a directory");
    // Larger than one read, to exercise chunked transfers both ways.
    const big = "0123456789abcdef".repeat(20_000);
    await put(sftp, "/big.txt", big);
    assert.equal(await get(sftp, "/big.txt"), big);
  } finally { end(); await closed; }
  // The session's changes reach the activity log once, when it ends.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const last = summaries.at(-1)!;
  assert.ok(last.uploaded.includes("big.txt"));
  assert.ok(last.deleted.includes("plugins/config/hello.yml"));
});

test("replies to pipelined writes come back in the order they were sent", async () => {
  // WinSCP drops the connection ("Received SSH2_MSG_CHANNEL_DATA for nonexistent channel 0") when
  // replies to its pipelined writes overtake each other, so the server answers in arrival order.
  const { sftp, end, closed } = await connect({ privateKey: clientKey.private });
  try {
    const handle = await call<Buffer>((done) => sftp.open("/pipelined.bin", "w", done));
    const chunk = Buffer.alloc(32 * 1024, 7);
    const order: number[] = [];
    await Promise.all(Array.from({ length: 64 }, (_, index) => call<void>((done) => sftp.write(handle, chunk, 0, chunk.length, index * chunk.length, (error) => { order.push(index); done(error); }))));
    await call<void>((done) => sftp.close(handle, done));
    assert.deepEqual(order, Array.from({ length: 64 }, (_, index) => index));
    assert.equal((await readFile(path.join(root, "pipelined.bin"))).length, 64 * chunk.length);
  } finally { end(); await closed; }
});

test("paths above the root land inside it, and nothing outside is reachable", async () => {
  const { sftp, end, closed } = await connect({ password: "correct-sftp-password" });
  try {
    assert.deepEqual(await list(sftp, "/../.."), await list(sftp, "/"));
    await assert.rejects(get(sftp, "../outside/secret.txt"), (error) => code(error) === 2);
    await put(sftp, "../../escape.txt", "x");
    assert.equal(await readFile(path.join(root, "escape.txt"), "utf8"), "x");
    await assert.rejects(readFile(path.join(folder, "escape.txt")));
    // Links can't be made.
    await assert.rejects(call<void>((done) => sftp.symlink("/etc/passwd", "/passwd", done)));
  } finally { end(); await closed; }
});

test("symlinks the game plants are never followed", { skip: !linkTests && "no symlinks without admin rights on Windows" }, async () => {
  await symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link.txt"));
  await symlink(outside, path.join(root, "outside-dir"));
  const { sftp, end, closed } = await connect({ password: "correct-sftp-password" });
  try {
    const names = await list(sftp, "/");
    assert.ok(!names.includes("secret-link.txt") && !names.includes("outside-dir"), "links aren't listed");
    await assert.rejects(get(sftp, "/secret-link.txt"), "reading through a file link fails");
    await assert.rejects(call((done) => sftp.stat("/secret-link.txt", done)), (error) => code(error) === 2);
    await assert.rejects(list(sftp, "/outside-dir"), "listing through a directory link fails");
    await assert.rejects(put(sftp, "/outside-dir/planted.txt", "x"), "writing through a directory link fails");
    await assert.rejects(put(sftp, "/secret-link.txt", "overwritten"), "writing through a file link fails");
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside the server");
    await assert.rejects(readFile(path.join(outside, "planted.txt")));
    // Deleting a link removes the link, never its target.
    await call<void>((done) => sftp.unlink("/secret-link.txt", done));
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside the server");
  } finally { end(); await closed; await rm(path.join(root, "outside-dir"), { force: true }); }
});

test("a folder swapped for a link mid-session doesn't redirect an open listing", { skip: process.platform !== "linux" }, async () => {
  await mkdir(path.join(root, "world"), { recursive: true });
  await writeFile(path.join(root, "world", "level.dat"), "level");
  const { sftp, end, closed } = await connect({ password: "correct-sftp-password" });
  try {
    const handle = await call<Buffer>((done) => sftp.opendir("/world", done));
    await rename(path.join(root, "world"), path.join(root, "world-moved"));
    await symlink(outside, path.join(root, "world"));
    const entries = await call<{ filename: string }[]>((done) => sftp.readdir(handle, done));
    assert.deepEqual(entries.map((entry) => entry.filename), ["level.dat"], "the held directory is read, not the link");
    await call<void>((done) => sftp.close(handle, done));
  } finally { end(); await closed; await rm(path.join(root, "world"), { force: true }); }
});

test("removing access ends the session at its next request", async () => {
  const { sftp, end, closed } = await connect({ password: "correct-sftp-password" });
  try {
    allowed = false;
    // The check is cached for a few seconds; wait it out.
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await assert.rejects(list(sftp, "/"), (error) => code(error) === 3);
    await closed;
  } finally { allowed = true; end(); }
});

test("shells and commands are refused", async () => {
  const client = new ssh2.Client();
  await new Promise<void>((resolve, reject) => { client.on("ready", () => resolve()).on("error", reject).connect({ host: "127.0.0.1", port, username: "steve.abc12345", password: "correct-sftp-password", hostVerifier: () => true }); });
  try {
    await assert.rejects(call((done) => client.exec("id", done)));
    await assert.rejects(call((done) => client.shell(done)));
  } finally { client.end(); }
});

test("a user can't open more than the allowed number of connections", async () => {
  const sessions = await Promise.all([1, 2, 3].map(() => connect({ password: "correct-sftp-password" })));
  try { await assert.rejects(connect({ password: "correct-sftp-password" })); }
  finally { for (const session of sessions) session.end(); await Promise.all(sessions.map((session) => session.closed)); }
});
