import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkbasePlatform, chunkbaseUrl, isNumericSeed, parseSeedReply } from "../lib/chunkbase.ts";

test("a server version maps to the seed map version that covers it", () => {
  assert.equal(chunkbasePlatform("26.3"), "java_26_3");
  assert.equal(chunkbasePlatform("1.21.8"), "java_1_21_6");
  assert.equal(chunkbasePlatform("1.21.11"), "java_1_21_9");
  assert.equal(chunkbasePlatform("1.21.1"), "java_1_21");
  assert.equal(chunkbasePlatform("1.21"), "java_1_21");
  assert.equal(chunkbasePlatform("1.19.4"), "java_1_19_3");
  assert.equal(chunkbasePlatform("1.12.2"), "java_1_12");
  assert.equal(chunkbasePlatform("26.9"), "java_26_4", "newer releases use the newest map");
  assert.equal(chunkbasePlatform("1.6.4"), undefined, "older than any map");
  assert.equal(chunkbasePlatform("LATEST"), undefined);
  assert.equal(chunkbasePlatform("25w14a"), undefined);
});

test("the link carries the seed and, when known, the map version", () => {
  assert.equal(chunkbaseUrl("-2084223887464857499", "26.3"), "https://www.chunkbase.com/apps/seed-map#seed=-2084223887464857499&platform=java_26_3&dimension=overworld&x=0&z=0&zoom=1");
  assert.equal(chunkbaseUrl("42", "LATEST"), "https://www.chunkbase.com/apps/seed-map#seed=42&dimension=overworld&x=0&z=0&zoom=1");
});

test("seeds are whole numbers in Java's long range, read from the game's reply to /seed", () => {
  assert.equal(isNumericSeed("-9223372036854775808"), true);
  assert.equal(isNumericSeed("9223372036854775807"), true);
  assert.equal(isNumericSeed("9223372036854775808"), false);
  assert.equal(isNumericSeed("glacier"), false);
  assert.equal(parseSeedReply("Seed: [-4172144997902289642]"), "-4172144997902289642");
  assert.equal(parseSeedReply("[12:00:00 INFO]: Seed: [123]\n"), "123");
  assert.equal(parseSeedReply("Unknown command"), undefined);
});
