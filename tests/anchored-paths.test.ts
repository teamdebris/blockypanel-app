import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { anchorDirectory, anchorParent, insideRoot, removeAnchored } from "../lib/anchored-paths.ts";

test("containment accepts ordinary names starting with two dots", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-anchor-"));
  try {
    const child = path.join(folder, "..cache");
    await mkdir(child);
    assert.equal(insideRoot(folder, child), true);
    assert.equal(insideRoot(folder, path.dirname(folder)), false);
    const parent = await anchorParent(folder, "..cache/config.txt");
    try {
      assert.equal(parent.name, "config.txt");
      await writeFile(path.join(parent.path, parent.name), "ok");
    } finally { await parent.close(); }
    assert.equal(await readFile(path.join(child, "config.txt"), "utf8"), "ok");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a renamed directory handle does not follow a replacement symlink", { skip: process.platform !== "linux" }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-anchor-"));
  try {
    const root = path.join(folder, "root");
    const outside = path.join(folder, "outside");
    await mkdir(root);
    await mkdir(outside);
    await mkdir(path.join(root, "inside"));
    const anchored = await anchorDirectory(root, "inside");
    try {
      await rename(path.join(root, "inside"), path.join(root, "moved"));
      await symlink(outside, path.join(root, "inside"));
      await writeFile(path.join(anchored.path, "safe.txt"), "safe");
    } finally { await anchored.close(); }
    assert.equal(await readFile(path.join(root, "moved", "safe.txt"), "utf8"), "safe");
    await assert.rejects(readFile(path.join(outside, "safe.txt")));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a held archive handle keeps reading the original file after replacement", { skip: process.platform !== "linux" }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-archive-handle-"));
  try {
    const archive = path.join(folder, "world.zip");
    await writeFile(archive, "original archive");
    const handle = await open(archive, "r");
    try {
      await rename(archive, path.join(folder, "moved.zip"));
      await writeFile(archive, "replacement");
      assert.equal(await readFile(`/proc/self/fd/${handle.fd}`, "utf8"), "original archive");
    } finally { await handle.close(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("anchored deletion removes a tree, and unlinks a link instead of following it", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-remove-"));
  try {
    const root = path.join(folder, "root");
    const outside = path.join(folder, "outside");
    await mkdir(path.join(root, "plugins", "config", "deep"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, "plugins", "config", "deep", "a.yml"), "a");
    await writeFile(path.join(root, "plugins", "b.jar"), "b");
    await writeFile(path.join(outside, "keep.txt"), "keep");
    const anchored = await anchorDirectory(root);
    try {
      await removeAnchored(anchored.path, "plugins");
      await assert.rejects(readFile(path.join(root, "plugins", "b.jar")));
      if (process.platform !== "win32") {
        await symlink(outside, path.join(root, "link"));
        await removeAnchored(anchored.path, "link");
        await assert.rejects(lstat(path.join(root, "link")));
        assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
      }
    } finally { await anchored.close(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("anchored deletion works through the held directory after its name is swapped for a link", { skip: process.platform !== "linux" }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "blocky-remove-swap-"));
  try {
    const root = path.join(folder, "root");
    const outside = path.join(folder, "outside");
    await mkdir(path.join(root, "victim", "inner"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, "victim", "inner", "gone.txt"), "gone");
    await writeFile(path.join(outside, "keep.txt"), "keep");
    // The parent is anchored (as deleteServerFile does), then the game swaps it for a link elsewhere.
    const anchored = await anchorDirectory(root, "victim");
    try {
      await rename(path.join(root, "victim"), path.join(root, "moved"));
      await symlink(outside, path.join(root, "victim"));
      await removeAnchored(anchored.path, "inner");
    } finally { await anchored.close(); }
    await assert.rejects(lstat(path.join(root, "moved", "inner")));
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
    // Deleting the swapped name itself removes only the link.
    const rootDir = await anchorDirectory(root);
    try { await removeAnchored(rootDir.path, "victim"); } finally { await rootDir.close(); }
    await assert.rejects(lstat(path.join(root, "victim")));
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
