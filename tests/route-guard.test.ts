import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? routeFiles(full) : entry.name === "route.ts" ? [full] : [];
  });
}

test("every API route handler runs the permission checks itself first, not only in proxy.ts", () => {
  const handler = /export async function (GET|POST|PUT|PATCH|DELETE)\(([^)]*)\)[^{]*\{\s*([^\n]*)/g;
  let count = 0;
  for (const file of routeFiles("app/api")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(handler)) {
      count += 1;
      assert.match(match[3], /^(const refusal = await guardRoute\(request\); if \(refusal\) return refusal;|const refusal = await guardApiRequest\(request\);)/, `${file} ${match[1]} must start with the route guard`);
    }
  }
  assert.ok(count > 50, `found ${count} handlers`);
});
