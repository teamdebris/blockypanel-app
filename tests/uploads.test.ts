import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { API_ACCESS, apiAccess } from "../lib/roles.ts";

// Upload routes skip proxy.ts so their bodies stream instead of being cut off at 10 MB. That makes
// these routes responsible for their own checks, so this test holds them to it.

async function routeFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? routeFiles(path.join(folder, entry.name)) : Promise.resolve(entry.name === "route.ts" ? [path.join(folder, entry.name)] : [])));
  return nested.flat();
}

test("the proxy skips /api/uploads/ and nothing else under /api", async () => {
  const proxy = await readFile("proxy.ts", "utf8");
  const matcher = proxy.match(/matcher:\s*\["([^"]+)"\]/)?.[1];
  assert.ok(matcher, "proxy.ts has a matcher");
  const regex = new RegExp(`^${matcher}$`);
  assert.equal(regex.test("/api/uploads/servers/abc"), false);
  assert.equal(regex.test("/api/servers/abc/files"), true);
  assert.equal(regex.test("/api/upload"), true, "only the exact prefix is skipped");
  const guard = await readFile("lib/request-guard.ts", "utf8");
  assert.match(guard, /STREAMED_PREFIX = "\/api\/uploads\/"/);
});

test("every upload route runs the API checks itself", async () => {
  const files = await routeFiles(path.join("app", "api", "uploads"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const method of source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(([^)]*)\)\s*\{\s*([^\n]*)/g)) {
      assert.match(method[3], /guardApiRequest\(request\)/, `${method[1]} in ${file} must call guardApiRequest first`);
    }
  }
});

test("uploads are admin-only, like the rest of file management", () => {
  assert.equal(apiAccess("/api/uploads/servers/abc", "PUT"), "admin");
  assert.equal(apiAccess("/api/uploads/servers/abc", "POST"), undefined);
  assert.equal(API_ACCESS["/api/servers/[id]/files"]?.PUT, undefined, "the old upload method, which the proxy truncated, is gone");
});
