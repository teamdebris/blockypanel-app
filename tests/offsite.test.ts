import assert from "node:assert/strict";
import { test } from "node:test";
import { folderPathProblem, parseIndex, passphraseProblem, repositoryFor, s3Endpoint, scrubSecrets, secretsOf, serializeIndex, type OffsiteDestination } from "../lib/offsite-core.ts";

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
