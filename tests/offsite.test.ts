import assert from "node:assert/strict";
import { test } from "node:test";
import { isNoRepository, isWrongPassword, ResticError } from "../lib/offsite-restic.ts";
import { folderPathProblem, friendlyDestinationError, parseIndex, passphraseProblem, repositoryFor, s3Endpoint, scrubSecrets, secretsOf, serializeIndex, type OffsiteDestination } from "../lib/offsite-core.ts";

const s3: OffsiteDestination = { kind: "s3", provider: "b2", endpoint: "", region: "us-west-004", bucket: "my-worlds", prefix: "blocky/", accessKeyId: "004abc", secretAccessKey: "K004secret" };

test("S3 presets fill in the endpoint", () => {
  assert.equal(s3Endpoint({ ...s3, provider: "b2" }), "s3.us-west-004.backblazeb2.com");
  assert.equal(s3Endpoint({ ...s3, provider: "wasabi", region: "eu-central-1" }), "s3.eu-central-1.wasabisys.com");
  assert.equal(s3Endpoint({ ...s3, provider: "aws", region: "us-east-2" }), "s3.us-east-2.amazonaws.com");
  assert.equal(s3Endpoint({ ...s3, provider: "r2", endpoint: "https://abc123.r2.cloudflarestorage.com/" }), "abc123.r2.cloudflarestorage.com");
  assert.equal(s3Endpoint({ ...s3, provider: "minio", endpoint: "http://nas.local:9000" }), "http://nas.local:9000");
});

test("repositories live under index/ and servers/<id>/ at the destination", () => {
  assert.equal(repositoryFor(s3, "index"), "s3:https://s3.us-west-004.backblazeb2.com/my-worlds/blocky/index");
  assert.equal(repositoryFor(s3, { server: "a7c31e481f20" }), "s3:https://s3.us-west-004.backblazeb2.com/my-worlds/blocky/servers/a7c31e481f20");
  assert.equal(repositoryFor({ ...s3, prefix: "" }, "index"), "s3:https://s3.us-west-004.backblazeb2.com/my-worlds/index");
  assert.equal(repositoryFor({ ...s3, provider: "minio", endpoint: "http://nas.local:9000" }, "index"), "s3:http://nas.local:9000/my-worlds/blocky/index");
  const sftp: OffsiteDestination = { kind: "sftp", host: "nas.local", port: 2222, user: "backup", path: "/volume1/blocky", auth: "key" };
  assert.equal(repositoryFor(sftp, "index"), "sftp:backup@nas.local:/volume1/blocky/index");
  assert.equal(repositoryFor({ kind: "folder", path: "/mnt/backup" }, { server: "x1" }), "/mnt/backup/servers/x1");
  assert.equal(repositoryFor({ kind: "folder", path: "/mnt/backup" }, "index", "/dest"), "/dest/index");
});

test("folder destinations must be real, separate folders", () => {
  assert.equal(folderPathProblem("/mnt/backup", "/var/lib/blocky"), null);
  assert.equal(folderPathProblem("/srv/minecraft-backups", "/opt/blocky-panel"), null);
  for (const path of ["relative/path", "/", "/etc", "/etc/blocky", "/usr/local/x", "/proc", "/var/run/docker.sock", "/opt/blocky-panel", "/opt/blocky-panel/servers", "/mnt/../etc"]) {
    assert.ok(folderPathProblem(path, "/opt/blocky-panel"), path);
  }
});

test("backup passphrases must be long", () => {
  assert.equal(passphraseProblem("correct horse battery staple glacier"), null);
  assert.equal(passphraseProblem("a-long-random-passphrase-01"), null);
  assert.ok(passphraseProblem("short words here"));
  assert.ok(passphraseProblem("tooshort123"));
});

test("secrets are scrubbed from error messages", () => {
  const secrets = secretsOf(s3);
  assert.deepEqual(secrets, ["K004secret"]);
  assert.equal(scrubSecrets("auth failed for K004secret at host", secrets), "auth failed for [hidden] at host");
  assert.equal(scrubSecrets("nothing secret", []), "nothing secret");
  assert.deepEqual(secretsOf({ kind: "sftp", host: "h", port: 22, user: "u", path: "/p", auth: "password", password: "hunter2hunter2" }), ["hunter2hunter2"]);
});

test("the index round-trips and rejects malformed data", () => {
  const index = { version: 1 as const, panelId: "p1", updatedAt: "2026-09-24T00:00:00.000Z", servers: { a1: { name: "Survival", type: "PAPER", version: "1.21.8", repositoryPassword: "abc", lastCopyAt: "2026-09-24T00:00:00.000Z" } } };
  assert.deepEqual(parseIndex(serializeIndex(index)), index);
  assert.throws(() => parseIndex("{\"version\": 2}"));
  assert.throws(() => parseIndex("not json"));
  assert.throws(() => parseIndex(JSON.stringify({ ...index, servers: { "../x": index.servers.a1 } })));
});

test("a refused login is never mistaken for an empty destination", () => {
  const error = (message: string, code = 1) => new ResticError(message, code);
  // restic 0.18 against S3 with a wrong secret (seen on a real server).
  assert.equal(isNoRepository(error("Fatal: unable to open config file: Stat: Access Denied.")), false);
  assert.equal(isNoRepository(error("Fatal: unable to open config file: Stat: The request signature we calculated does not match the signature you provided.")), false);
  assert.equal(isNoRepository(error("Fatal: repository does not exist: unable to open config file: Stat: Access Denied.", 10)), false);
  // Genuinely missing, on current and older restic.
  assert.equal(isNoRepository(error("Fatal: repository does not exist: unable to open config file: stat /mnt/x/index/config: no such file or directory", 10)), true);
  assert.equal(isNoRepository(error("Fatal: unable to open config file: stat /tmp/x/destination/index/config: no such file or directory")), true);
  assert.equal(isNoRepository(error("Fatal: unable to open config file: Stat: The specified key does not exist.")), true);
  assert.equal(isNoRepository(error("Fatal: unable to open config file: Stat: The specified bucket does not exist. NoSuchBucket")), false);
  assert.equal(isNoRepository(new Error("The destination didn't answer in time.")), false);
  assert.equal(isWrongPassword(error("Fatal: wrong password or no key found")), true);
  assert.equal(isWrongPassword(error("Fatal: wrong password or no key found", 12)), true);
});

test("destination failures are explained by what actually went wrong", () => {
  const kind = (message: string) => friendlyDestinationError(message)?.message.split(".")[0];
  // Exact messages seen on a test server.
  assert.equal(kind("subprocess sshpass: Permission denied, please try again.\nFatal: unable to open repository at sftp:e2e@host:/upload/x: unable to start the sftp session"), "The destination refused the login");
  assert.equal(kind("subprocess ssh: e2e@host: Permission denied (publickey,password)."), "The destination refused the login");
  assert.equal(kind("Fatal: create repository at sftp:e2e@host:/upload/x/index failed: MkdirAll /upload/x/index/locks: permission denied"), "Signed in, but this account can't write to that folder");
  assert.equal(kind("subprocess sshpass: Host key for [host]:2222 has changed and you have requested strict checking.\nsubprocess sshpass: Host key verification failed."), "The server's SSH host key doesn't match the one saved");
  assert.equal(kind("Fatal: unable to open config file: Stat: Access Denied."), "The storage provider refused the keys");
  assert.equal(kind("Stat: The request signature we calculated does not match the signature you provided."), "The storage provider refused the keys");
  assert.equal(kind("The specified bucket does not exist. NoSuchBucket"), "That bucket doesn't exist");
  assert.equal(kind("ssh: connect to host nas.local port 22: Connection refused"), "Couldn't reach the destination");
  assert.equal(friendlyDestinationError("something else entirely"), undefined);
});
