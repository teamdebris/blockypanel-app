import assert from "node:assert/strict";
import { test } from "node:test";
import { backupNameSchema, commandSchema, createServerSchema, rerollSchema } from "../lib/validation.ts";

const base = { name: "Survival", type: "PAPER", version: "1.21.8", memory: "4G", port: 25565, difficulty: "normal", maxPlayers: 20, eula: true };

test("accepts a minimal server and fills defaults", () => {
  const parsed = createServerSchema.parse(base);
  assert.equal(parsed.javaVersion, "auto");
  assert.equal(parsed.cpuLimit, 0);
});

test("accepts modded server types", () => {
  for (const type of ["FABRIC", "QUILT", "FORGE", "NEOFORGE"]) assert.equal(createServerSchema.parse({ ...base, type }).type, type);
});

test("rejects properties that would break RCON backups or the port mapping", () => {
  for (const line of ["enable-rcon=false", "rcon.password=x", "RCON.PORT=1", "server-port=1"]) {
    assert.equal(createServerSchema.safeParse({ ...base, customProperties: line }).success, false, line);
  }
  assert.equal(createServerSchema.safeParse({ ...base, customProperties: "spawn-protection=0" }).success, true);
});

test("rejects whitelist entries that could inject into the environment", () => {
  assert.equal(createServerSchema.safeParse({ ...base, whitelist: ["Steve,Alex"] }).success, false);
  assert.equal(createServerSchema.safeParse({ ...base, whitelist: ["Steve", "069a79f4-44e9-4726-a5be-fca90e38aaf5"] }).success, true);
});

test("console commands must be a single line", () => {
  assert.equal(commandSchema.safeParse({ command: "say hi" }).success, true);
  assert.equal(commandSchema.safeParse({ command: "say hi\nop attacker" }).success, false);
});

test("backup names are restic snapshot IDs only", () => {
  assert.equal(backupNameSchema.safeParse(`snapshot-${"a".repeat(64)}`).success, true);
  for (const name of ["manual-2026.tar", "../x.tar", "a/b.tar", "snapshot-xyz", `snapshot-${"a".repeat(64)}/../x`]) assert.equal(backupNameSchema.safeParse(name).success, false, name);
});

test("seeds can't inject server.properties lines", () => {
  // A line break would let a seed add protected properties (e.g. enable-rcon=false).
  assert.equal(createServerSchema.safeParse({ ...base, seed: "123\nenable-rcon=false" }).success, false);
  assert.equal(rerollSchema.safeParse({ seed: "1\nlevel-name=../x" }).success, false);
  assert.equal(rerollSchema.parse({}).seed, "");
  assert.equal(rerollSchema.parse({ seed: " my seed " }).seed, "my seed");
});
