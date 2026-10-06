import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateHost } from "../lib/private-host.ts";

test("hosts on this machine or a private network are private", () => {
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.16", "169.254.1.1", "100.64.0.1", "100.127.1.1", "::1", "[::1]", "fd12:3456::1", "fe80::1", "blocky", "nas.local", "panel.lan", "box.home.arpa"]) assert.ok(isPrivateHost(host), host);
});

test("public addresses and domains are not", () => {
  for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.10", "panel.example.com", "2001:db8::1", "demo.blockypanel.com"]) assert.ok(!isPrivateHost(host), host);
});
