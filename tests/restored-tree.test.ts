import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sanitizeRestoredTree } from "../lib/restored-tree.ts";

test("a restored tree loses setuid and setgid bits, keeps its contents, and links aren't followed", { skip: process.platform === "win32" && "no setuid on Windows" }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-restored-"));
  try {
    const data = path.join(folder, "data");
    const outside = path.join(folder, "outside");
    await mkdir(path.join(data, "plugins"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(data, "plugins", "shell"), "#!/bin/sh\n");
    await chmod(path.join(data, "plugins", "shell"), 0o4755);
    await writeFile(path.join(data, "server.properties"), "level-name=world\n");
    await chmod(path.join(data, "server.properties"), 0o640);
    await writeFile(path.join(outside, "suid"), "");
    await chmod(path.join(outside, "suid"), 0o4755);
    await symlink(path.join(outside, "suid"), path.join(data, "link"));
    // Only the uid this test runs as can be assigned without root; the bits are what's checked.
    await sanitizeRestoredTree(data, { uid: process.getuid!(), gid: process.getgid!() });
    assert.equal((await lstat(path.join(data, "plugins", "shell"))).mode & 0o7777, 0o755);
    assert.equal((await lstat(path.join(data, "server.properties"))).mode & 0o7777, 0o640);
    assert.equal(await readFile(path.join(data, "plugins", "shell"), "utf8"), "#!/bin/sh\n");
    assert.equal((await lstat(path.join(outside, "suid"))).mode & 0o7777, 0o4755, "the link's target is untouched");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
