import assert from "node:assert/strict";
import { test } from "node:test";
import { isServerIcon, SERVER_ICONS, serverIcon } from "../lib/server-icons.ts";

test("a picked icon wins; anything else falls back to a block from the server ID", () => {
  assert.equal(serverIcon({ id: "a7c31e481f20", icon: "creeper" }), "creeper");
  const fallback = serverIcon({ id: "a7c31e481f20" });
  assert.ok(SERVER_ICONS.slice(0, 8).includes(fallback), "the default is a block, not a mob");
  assert.equal(serverIcon({ id: "a7c31e481f20", icon: "chest-ender" }), fallback, "chests stand for backups and aren't server icons");
  assert.equal(serverIcon({ id: "a7c31e481f20", icon: "../../etc/passwd" }), fallback);
});

test("the default is the same every time, and servers get different ones", () => {
  assert.equal(serverIcon({ id: "f2089bdc610a" }), serverIcon({ id: "f2089bdc610a" }));
  const ids = ["a7c31e481f20", "f2089bdc610a", "0123456789ab", "deadbeef0000", "c0ffee123456", "1234abcd5678"];
  assert.ok(new Set(ids.map((id) => serverIcon({ id }))).size > 1);
});

test("only the listed icons are accepted", () => {
  for (const icon of SERVER_ICONS) assert.ok(isServerIcon(icon));
  for (const bad of ["chest-storage", "Creeper", "", undefined, 3]) assert.ok(!isServerIcon(bad), String(bad));
});
