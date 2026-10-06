import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AccountStore } from "../lib/account-store.ts";
import { apiAccess } from "../lib/roles.ts";
import { SecretBox, sameSecret } from "../lib/secret-box.ts";

const SERVER = "953dfb01-d789-4e40-a8d3-b4a80258ff7b";
const OTHER = "1a2b3c4d-0000-4000-8000-000000000000";

test("a secret box opens what it sealed, and nothing sealed with another key or changed", () => {
  const box = SecretBox.random();
  const sealed = box.seal("maple otter lantern");
  assert.match(sealed, /^v1\./);
  assert.notEqual(box.seal("maple otter lantern"), sealed, "each seal uses a fresh IV");
  assert.equal(box.open(sealed), "maple otter lantern");
  assert.equal(SecretBox.random().open(sealed), undefined);
  // Flip one bit of the ciphertext itself. (Editing base64 characters isn't enough: the last one partly
  // holds padding bits that decode to the same bytes, which made this test fail about 1 run in 256.)
  const [v, iv, tag, data] = sealed.split(".");
  const tampered = Buffer.from(data, "base64url"); tampered[0] ^= 1;
  assert.equal(box.open([v, iv, tag, tampered.toString("base64url")].join(".")), undefined);
  assert.equal(box.open("not sealed"), undefined);
  assert.throws(() => new SecretBox(Buffer.alloc(16)));
  assert.equal(sameSecret("a", "a"), true);
  assert.equal(sameSecret("a", "ab"), false);
});

test("each account gets its own password per server, kept until it's re-rolled", async () => {
  const db = new DatabaseSync(":memory:");
  const box = SecretBox.random();
  const accounts = new AccountStore(db, Date.now, box);
  const alex = await accounts.createUser("alex", "a-long-password-1", "admin");
  const sam = await accounts.createUser("sam", "a-long-password-2", "admin");

  const first = accounts.serverSftpPassword(alex.id, SERVER);
  assert.ok(first.password.length >= 32);
  assert.equal(accounts.serverSftpPassword(alex.id, SERVER).password, first.password, "shown again, not remade");
  assert.notEqual(accounts.serverSftpPassword(alex.id, OTHER).password, first.password, "another server, another password");
  assert.notEqual(accounts.serverSftpPassword(sam.id, SERVER).password, first.password, "another account, another password");

  // Stored encrypted, never as plain text.
  const stored = db.prepare("SELECT password_sealed FROM sftp_server_passwords").all().map((row) => String(row.password_sealed));
  assert.ok(stored.every((value) => value.startsWith("v1.") && !value.includes(first.password)));

  const credential = accounts.serverSftpPasswordCredential(alex.id, SERVER, first.password);
  assert.ok(credential);
  assert.equal(accounts.serverSftpPasswordCredential(alex.id, OTHER, first.password), undefined, "only opens its own server");
  assert.equal(accounts.serverSftpPasswordCredential(sam.id, SERVER, first.password), undefined, "only for its own account");
  assert.equal(accounts.serverSftpPasswordCredential(alex.id, SERVER, "wrong"), undefined);
  assert.equal(accounts.sftpCredentialActive(credential), true);

  // Re-rolling: the old password stops working and sessions that used it end.
  const second = accounts.rerollServerSftpPassword(alex.id, SERVER);
  assert.notEqual(second.password, first.password);
  assert.equal(accounts.serverSftpPasswordCredential(alex.id, SERVER, first.password), undefined);
  assert.equal(accounts.sftpCredentialActive(credential), false);
  assert.ok(accounts.serverSftpPasswordCredential(alex.id, SERVER, second.password));

  // A removed server takes its passwords with it.
  const live = accounts.serverSftpPasswordCredential(alex.id, SERVER, second.password)!;
  accounts.touchSftpCredential(live);
  assert.ok(accounts.serverSftpPassword(alex.id, SERVER).lastUsedAt);
  accounts.deleteServerSftpPasswords(SERVER);
  assert.equal(accounts.serverSftpPasswordCredential(alex.id, SERVER, second.password), undefined);
  assert.equal(accounts.sftpCredentialActive(live), false);
});

test("a password sealed with a lost key is replaced instead of breaking the tab", async () => {
  const db = new DatabaseSync(":memory:");
  const before = new AccountStore(db, Date.now, SecretBox.random());
  const alex = await before.createUser("alex", "a-long-password-1", "admin");
  const old = before.serverSftpPassword(alex.id, SERVER).password;
  // Same database, new key file (say, panel.db restored without secret.key).
  const after = new AccountStore(db, Date.now, SecretBox.random());
  assert.equal(after.serverSftpPasswordCredential(alex.id, SERVER, old), undefined);
  const fresh = after.serverSftpPassword(alex.id, SERVER).password;
  assert.notEqual(fresh, old);
  assert.ok(after.serverSftpPasswordCredential(alex.id, SERVER, fresh));
});

test("only admins can see or re-roll a server's SFTP password", () => {
  assert.equal(apiAccess("/api/servers/abc/sftp", "GET"), "admin");
  assert.equal(apiAccess("/api/servers/abc/sftp", "POST"), "admin");
});
