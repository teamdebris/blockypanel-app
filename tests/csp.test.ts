import assert from "node:assert/strict";
import { test } from "node:test";
import { newNonce, pagePolicy } from "../lib/csp.ts";

test("pages only run scripts carrying this response's nonce", () => {
  const nonce = newNonce();
  const policy = pagePolicy(nonce, false);
  assert.ok(policy.includes(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic';`), policy);
  for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) assert.ok(policy.includes(directive), directive);
  assert.ok(!policy.includes("unsafe-eval"), "no eval outside development");
  assert.ok(!policy.includes("upgrade-insecure-requests"), "plain-HTTP LAN installs must keep loading their own scripts");
  assert.notEqual(newNonce(), nonce);
});
