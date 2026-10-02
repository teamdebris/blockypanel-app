import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BackupCredentials, checkinServers, nextCopyAllowedAt, cloudAddresses, cloudPrefix, needsNewCredentials, nextCheckinDelay, normalizeCloudUrl, parseCheckin, parseCredentials, versionAtLeast,
} from "../lib/cloud-core.ts";
import { describeDestination, repositoryFor } from "../lib/offsite-core.ts";

// Shaped like Blocky Cloud's POST /v1/checkin response (blockypanel-cloud, CheckinController).
const checkin = {
  account: { email: "alex@example.com" },
  subscription: { state: "active", plan: "standard", graceEndsAt: null, lapsedAt: null },
  entitlements: { names: 1, serversPerName: 10, storageBytes: 268435456000 },
  names: [{
    name: "alex", fqdn: "alex.blockylink.net", state: "active", ip: "203.0.113.10",
    servers: [
      { id: "a7c31e481f20", label: "survival", fqdn: "survival.alex.blockylink.net", port: 25565 },
      { id: "b19f00aa1c3d", label: "creative", fqdn: "creative.alex.blockylink.net", port: 25566 },
    ],
  }],
  backup: { available: true, readOnly: false, quotaBytes: 268435456000, usedBytes: 1024, deleteAfter: null, renewCredentials: false, copiesPerDay: null, folders: [{ id: "old-panel-1", name: "Old box", lastKeyAt: "2026-09-01T00:00:00+00:00" }] },
  minPanelVersion: "0.2.0",
  notices: [],
  nextCheckinSeconds: 300,
};

const credentials: BackupCredentials = {
  provider: "b2", keyId: "004key", applicationKey: "K004secret", bucket: "blocky-cloud", region: "us-west-004",
  endpoint: "s3.us-west-004.backblazeb2.com", prefix: "accounts/01jabc/", readOnly: false, expiresAt: "2026-12-01T00:00:00+00:00",
};

test("the Blocky Cloud address must be https, except on this machine", () => {
  assert.equal(normalizeCloudUrl(undefined), "https://cloud.blockypanel.com");
  assert.equal(normalizeCloudUrl("https://console.example.com/"), "https://console.example.com");
  assert.equal(normalizeCloudUrl("http://localhost:8000"), "http://localhost:8000");
  assert.throws(() => normalizeCloudUrl("http://console.example.com"), /https/);
  assert.throws(() => normalizeCloudUrl("https://user:pass@console.example.com"), /credentials/);
  assert.throws(() => normalizeCloudUrl("not a url"), /valid URL/);
});

test("check-ins follow Blocky Cloud's schedule and back off on failure", () => {
  assert.equal(nextCheckinDelay(0), 300);
  assert.equal(nextCheckinDelay(0, 10), 60, "never more often than once a minute");
  assert.equal(nextCheckinDelay(0, 99_999), 3600);
  const middle = () => 0.5;
  assert.equal(nextCheckinDelay(1, 300, middle), 60);
  assert.equal(nextCheckinDelay(3, 300, middle), 240);
  assert.equal(nextCheckinDelay(20, 300, middle), 3600, "capped at an hour");
  assert.equal(nextCheckinDelay(1, 300, () => 0), 45, "jitter spreads retries out");
});

test("versions compare by number", () => {
  assert.ok(versionAtLeast("0.2.0", "0.2.0"));
  assert.ok(versionAtLeast("0.10.0", "0.2.0"));
  assert.ok(versionAtLeast("v1.0.0", "0.9.9"));
  assert.ok(!versionAtLeast("0.1.1", "0.2.0"));
  assert.ok(versionAtLeast("0.2.0-dev", "0.2.0"));
});

test("check-in responses are parsed defensively", () => {
  const parsed = parseCheckin(checkin);
  assert.equal(parsed.subscription.state, "active");
  assert.equal(parsed.names[0].servers.length, 2);
  assert.equal(parsed.backup.available && parsed.backup.folders[0].id, "old-panel-1");
  assert.throws(() => parseCheckin({}), /understand/);
  const hostile = parseCheckin({ ...checkin, names: [{ ...checkin.names[0], fqdn: "<script>", servers: [] }, { ...checkin.names[0], servers: [{ id: "../x", fqdn: "x.alex.blockylink.net", port: 1 }] }] });
  assert.equal(hostile.names.length, 1, "names with odd characters are dropped");
  assert.equal(hostile.names[0].servers.length, 0, "servers with odd IDs are dropped");
  assert.equal(parseCheckin({ ...checkin, subscription: { state: "weird" } }).subscription.state, "none");
});

test("servers get their blockylink.net address only while the name publishes", () => {
  const parsed = parseCheckin(checkin);
  assert.deepEqual(cloudAddresses(parsed), { a7c31e481f20: "survival.alex.blockylink.net", b19f00aa1c3d: "creative.alex.blockylink.net" });
  assert.equal(Object.keys(cloudAddresses({ ...parsed, names: parsed.names.map((name) => ({ ...name, state: "frozen" as const })) })).length, 2, "frozen names still resolve");
  assert.deepEqual(cloudAddresses({ ...parsed, names: parsed.names.map((name) => ({ ...name, state: "reserved" as const })) }), {});
  assert.deepEqual(cloudAddresses(undefined), {});
});

test("check-in sends only well-formed servers", () => {
  assert.deepEqual(checkinServers([
    { id: "a7c31e481f20", name: "Survival", port: 25565 },
    { id: "bad/id", name: "x", port: 25566 },
    { id: "b19f00aa1c3d", name: "", port: 0 },
  ]), [{ id: "a7c31e481f20", name: "Survival", port: 25565 }]);
});

test("servers the owner turned off are left out of check-ins", () => {
  const servers = [{ id: "a7c31e481f20", name: "Lobby", port: 25565 }, { id: "b19f00aa1c3d", name: "Backend", port: 25566 }];
  assert.deepEqual(checkinServers(servers, ["b19f00aa1c3d"]).map((server) => server.id), ["a7c31e481f20"]);
  assert.equal(checkinServers(servers).length, 2, "published by default");
});

test("backup keys are renewed when they're close to expiring or Blocky Cloud asks", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const backup = parseCheckin(checkin).backup;
  assert.ok(needsNewCredentials(undefined, backup, now));
  assert.ok(!needsNewCredentials(credentials, backup, now));
  assert.ok(needsNewCredentials({ ...credentials, expiresAt: "2026-10-05T00:00:00Z" }, backup, now), "less than a week left");
  assert.ok(needsNewCredentials(credentials, { ...backup, available: true, renewCredentials: true } as typeof backup, now));
  assert.ok(needsNewCredentials(credentials, { ...backup, available: true, readOnly: true } as typeof backup, now), "the account went read-only");
});

test("backup credentials must stay inside the account's folder", () => {
  assert.equal(parseCredentials(credentials).keyId, "004key");
  assert.throws(() => parseCredentials({ ...credentials, prefix: "" }), /understand/);
  assert.throws(() => parseCredentials({ ...credentials, prefix: "accounts/../" }), /understand/);
  assert.throws(() => parseCredentials({ ...credentials, provider: "s3" }), /understand/);
  assert.throws(() => parseCredentials({ ...credentials, applicationKey: "" }), /understand/);
});

test("each panel keeps its copies in its own folder", () => {
  assert.equal(cloudPrefix(credentials, "3f2a9c1e-panel"), "accounts/01jabc/panels/3f2a9c1e-panel");
  assert.throws(() => cloudPrefix(credentials, "../other"), /panel folder/);
});

test("a Blocky Cloud destination is named, but must be resolved before use", () => {
  assert.equal(describeDestination({ kind: "cloud" }), "Blocky Cloud");
  assert.equal(describeDestination({ kind: "cloud", panel: "old-panel-1" }), "Blocky Cloud · panel old-pane");
  assert.throws(() => repositoryFor({ kind: "cloud" }, "index"), /resolved/);
});

test("the free plan's daily limit counts successful copies", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(nextCopyAllowedAt(null, "2026-10-02T11:00:00Z", now), null, "no limit on Standard");
  assert.equal(nextCopyAllowedAt(1, undefined, now), null, "the first copy can run now");
  assert.equal(nextCopyAllowedAt(1, "2026-10-01T11:00:00Z", now), null, "a day has passed");
  assert.equal(nextCopyAllowedAt(1, "2026-10-02T09:00:00Z", now), "2026-10-03T09:00:00.000Z");
  const free = parseCheckin({ ...checkin, backup: { ...checkin.backup, copiesPerDay: 1 } }).backup;
  assert.equal(free.available && free.copiesPerDay, 1);
  const standard = parseCheckin(checkin).backup;
  assert.equal(standard.available && standard.copiesPerDay, null);
});
