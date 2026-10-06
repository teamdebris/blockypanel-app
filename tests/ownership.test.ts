import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GAME_UID, giveTreeToGame } from "../lib/ownership.ts";

test("everything under the data folder that isn't the game's is handed to it, without touching links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "blocky-owner-"));
  const outside = await mkdtemp(path.join(tmpdir(), "blocky-outside-"));
  try {
    await mkdir(path.join(root, "mods", "config"), { recursive: true });
    await writeFile(path.join(root, "mods", "root-owned.jar"), "jar");
    await writeFile(path.join(root, "mods", "config", "settings.toml"), "x=1");
    await writeFile(path.join(outside, "secret.txt"), "not the game's");
    const links = process.platform !== "win32";
    if (links) await symlink(outside, path.join(root, "mods", "escape"));

    // Pretend the game already owns settings.toml; everything else is someone else's.
    const owned = new Set([path.join(root, "mods", "config", "settings.toml")]);
    const changed: string[] = [];
    const count = await giveTreeToGame(root, {
      lstat: async (file) => { const info = await lstat(file); return Object.assign(info, { uid: owned.has(file) ? GAME_UID : 0, gid: owned.has(file) ? GAME_UID : 0 }); },
      lchown: async (file, uid, gid) => { assert.equal(uid, GAME_UID); assert.equal(gid, GAME_UID); changed.push(path.relative(root, file) || "."); },
      readdir: (directory) => readdir(directory, { withFileTypes: true }),
    });

    assert.deepEqual(changed.sort(), [".", "mods", path.join("mods", "config"), path.join("mods", "root-owned.jar")].sort());
    assert.equal(count, changed.length);
    assert.ok(!changed.some((file) => file.includes("escape") || file.includes("secret")), "links are neither followed nor changed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a failed chown doesn't stop the rest, and a missing folder is fine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "blocky-owner-"));
  try {
    await writeFile(path.join(root, "a.jar"), "a");
    await writeFile(path.join(root, "b.jar"), "b");
    const tried: string[] = [];
    const count = await giveTreeToGame(root, {
      lstat: async (file) => Object.assign(await lstat(file), { uid: 0, gid: 0 }),
      lchown: async (file) => { tried.push(path.basename(file)); if (file.endsWith("a.jar")) throw new Error("EPERM"); },
      readdir: (directory) => readdir(directory, { withFileTypes: true }),
    });
    assert.ok(tried.includes("a.jar") && tried.includes("b.jar"));
    assert.equal(count, tried.length - 1);
    assert.equal(await giveTreeToGame(path.join(root, "missing")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
