import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeSeed, levelName, withProperty, worldFolders } from "../lib/world.ts";

test("the world folder comes from level-name, defaulting to world", () => {
  assert.equal(levelName(""), "world");
  assert.equal(levelName("motd=Hi\nlevel-name=survival\n"), "survival");
  assert.equal(levelName("level-name=\n"), "world");
  assert.equal(levelName("#level-name=ignored\nlevel-name = spaced \n"), "spaced");
});

test("level-name must be a plain folder name", () => {
  for (const value of ["../etc", "a/b", "a\\b", ".", "..", "/abs"]) assert.throws(() => levelName(`level-name=${value}\n`), value);
});

test("re-roll deletes the overworld, Nether, and End folders", () => {
  assert.deepEqual(worldFolders("world"), ["world", "world_nether", "world_the_end"]);
  assert.deepEqual(worldFolders("survival"), ["survival", "survival_nether", "survival_the_end"]);
});

test("setting a property replaces its line or appends one, keeping the rest", () => {
  assert.equal(withProperty("motd=Hi\nlevel-seed=123\npvp=true\n", "level-seed", ""), "motd=Hi\nlevel-seed=\npvp=true\n");
  assert.equal(withProperty("motd=Hi\n", "level-seed", "abc"), "motd=Hi\nlevel-seed=abc\n");
  assert.equal(withProperty("motd=Hi", "level-seed", "abc"), "motd=Hi\nlevel-seed=abc\n");
  assert.equal(withProperty("", "level-seed", "7"), "level-seed=7\n");
  assert.equal(withProperty("a=1\r\nlevel-seed=5\r\n", "level-seed", "9"), "a=1\r\nlevel-seed=9\r\n");
});

test("seeds can't carry line breaks or other control characters", () => {
  assert.equal(isSafeSeed(""), true);
  assert.equal(isSafeSeed("-1234567890"), true);
  assert.equal(isSafeSeed("my cool world"), true);
  assert.equal(isSafeSeed("1\nenable-rcon=false"), false);
  assert.equal(isSafeSeed("tab\there"), false);
});
