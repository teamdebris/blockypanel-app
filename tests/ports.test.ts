import assert from "node:assert/strict";
import { test } from "node:test";
import { bedrockPortOf, missingPresetPorts, ownPortProblem, parseExtraPorts, PORT_PRESETS, portBindings, portClash, usedPorts, withPluginPorts, type ExtraPort } from "../lib/ports.ts";
import { createServerSchema } from "../lib/validation.ts";

const env = { BLOCKY_SFTP_PORT: "2022" };
const map = (port: number, label = "BlueMap web map"): ExtraPort => ({ port, protocol: "tcp", target: 8100, label, preset: "bluemap" });
const voice: ExtraPort = { port: 24454, protocol: "udp", target: 24454, label: "Simple Voice Chat", preset: "voicechat" };

test("a server's own ports must work together, and RCON is never published", () => {
  assert.equal(ownPortProblem({ port: 25565, extraPorts: [map(8100), voice] }), undefined);
  assert.match(ownPortProblem({ port: 25565, extraPorts: [{ port: 25575, protocol: "tcp", target: 25575, label: "" }] })!, /RCON/);
  assert.match(ownPortProblem({ port: 25565, extraPorts: [{ port: 30000, protocol: "tcp", target: 25575, label: "" }] })!, /RCON/, "a different host port doesn't sneak RCON out");
  assert.match(ownPortProblem({ port: 25565, extraPorts: [{ port: 25565, protocol: "udp", target: 25565, label: "" }] })!, /UDP on the game port/);
  assert.match(ownPortProblem({ port: 25565, extraPorts: [map(8100), map(8100)] })!, /twice/);
  // The same number on TCP and UDP is two different ports.
  assert.equal(ownPortProblem({ port: 25565, extraPorts: [{ port: 9000, protocol: "tcp", target: 9000, label: "" }, { port: 9000, protocol: "udp", target: 9000, label: "" }] }), undefined);
});

test("ports clash across servers by number and protocol, and the panel's own ports are taken", () => {
  const used = usedPorts([{ name: "Survival", port: 25565, gamePortUdp: true, extraPorts: [map(8100), voice] }], env);
  assert.match(portClash({ port: 25566, extraPorts: [map(8100)] }, used)!, /8100 is already used by Survival/);
  assert.match(portClash({ port: 25566, extraPorts: [voice] }, used)!, /24454 \(UDP\) is already used by Survival/);
  assert.match(portClash({ port: 25565 }, used)!, /25565 is already used by Survival/);
  assert.match(portClash({ port: 25566, gamePortUdp: false, extraPorts: [{ port: 25565, protocol: "udp", target: 9000, label: "" }] }, used)!, /25565 \(UDP\)/, "another server's game port over UDP");
  assert.equal(portClash({ port: 25566, extraPorts: [{ port: 24454, protocol: "tcp", target: 24454, label: "" }] }, used), undefined, "TCP 24454 is free");
  assert.match(portClash({ port: 3000 }, used)!, /the panel/);
  assert.match(portClash({ port: 25570, extraPorts: [{ port: 2022, protocol: "tcp", target: 22, label: "" }] }, used)!, /the panel/);
});

test("plugins from the Modrinth list get their port, on a free one for maps and only the exact one for voice", () => {
  const plugins = [PORT_PRESETS.bluemap.modrinth, PORT_PRESETS.voicechat.modrinth];
  const first = withPluginPorts({ port: 25565, modrinthProjects: plugins, extraPorts: [] }, usedPorts([], env));
  assert.deepEqual(first.added.map((entry) => `${entry.port}->${entry.target}/${entry.protocol}`), ["8100->8100/tcp", "24454->24454/udp"]);
  assert.deepEqual(first.skipped, []);

  // A second server: the map moves to the next free host port (it doesn't care), voice can't move.
  const second = withPluginPorts({ port: 25566, modrinthProjects: plugins, extraPorts: [] }, usedPorts([{ name: "Survival", ...first.server }], env));
  assert.deepEqual(second.added.map((entry) => `${entry.port}->${entry.target}/${entry.protocol}`), ["8101->8100/tcp"]);
  assert.equal(second.skipped.length, 1);
  assert.match(second.skipped[0].reason, /24454\/UDP, which is already taken by Survival/);

  // Ports already open, and plugins not on the list, are left alone.
  const again = withPluginPorts(first.server, usedPorts([], env));
  assert.deepEqual(again.added, []);
  assert.equal(again.server.extraPorts.length, 2);
  assert.deepEqual(withPluginPorts({ port: 25565, modrinthProjects: ["AABBCCDD"], extraPorts: [] }, usedPorts([], env)).added, []);
});

test("map and voice plugins added by hand are found by jar name, unless their port is open", () => {
  assert.deepEqual(missingPresetPorts({ port: 25565, extraPorts: [] }, ["BlueMap-5.4-paper.jar", "voicechat-bukkit-2.5.30.jar", "EssentialsX.jar"]), ["bluemap", "voicechat"]);
  assert.deepEqual(missingPresetPorts({ port: 25565, extraPorts: [map(8100)] }, ["bluemap-5.4.jar"]), []);
  // A port typed by hand for the right container port counts as open too.
  assert.deepEqual(missingPresetPorts({ port: 25565, extraPorts: [{ port: 24454, protocol: "udp", target: 24454, label: "voice" }] }, ["voicechat-fabric.jar"]), []);
  assert.deepEqual(missingPresetPorts({ port: 25565, extraPorts: [], modrinthProjects: [PORT_PRESETS.voicechat.modrinth] }, []), ["voicechat"]);
});

test("Docker publishes the game port, UDP when asked, and each extra port on its container port", () => {
  const { ExposedPorts, PortBindings } = portBindings({ port: 25570, gamePortUdp: true, extraPorts: [map(8101), voice] });
  assert.deepEqual(Object.keys(ExposedPorts).sort(), ["24454/udp", "25565/tcp", "25565/udp", "8100/tcp"]);
  assert.deepEqual(PortBindings["25565/tcp"], [{ HostPort: "25570" }]);
  assert.deepEqual(PortBindings["25565/udp"], [{ HostPort: "25570" }]);
  assert.deepEqual(PortBindings["8100/tcp"], [{ HostPort: "8101" }]);
  assert.deepEqual(Object.keys(portBindings({ port: 25565 }).PortBindings), ["25565/tcp"]);
});

test("ports read back from a container label are checked, not trusted", () => {
  assert.deepEqual(parseExtraPorts(JSON.stringify([map(8100)])), [map(8100)]);
  assert.deepEqual(parseExtraPorts("not json"), []);
  assert.deepEqual(parseExtraPorts(JSON.stringify([{ port: 80, protocol: "tcp" }, { port: 9000, protocol: "sctp" }, { port: 9001, protocol: "udp" }])), [{ port: 9001, protocol: "udp", target: 9001, label: "" }]);
  assert.equal(parseExtraPorts(JSON.stringify(Array.from({ length: 30 }, (_, index) => ({ port: 9000 + index, protocol: "tcp" })))).length, 10);
});

test("server settings validate their ports", () => {
  const base = { name: "Survival", type: "PAPER", version: "1.21.8", memory: "4G", port: 25565, difficulty: "normal", maxPlayers: 20, eula: true };
  const parsed = createServerSchema.parse({ ...base, extraPorts: [{ port: 24454, protocol: "udp" }] });
  assert.deepEqual(parsed.extraPorts, [{ port: 24454, protocol: "udp", target: 24454, label: "" }]);
  assert.equal(parsed.gamePortUdp, false);
  for (const extraPorts of [[{ port: 80, protocol: "tcp" }], [{ port: 9000, protocol: "tcp", target: 25575 }], [{ port: 9000, protocol: "icmp" }]]) {
    assert.equal(createServerSchema.safeParse({ ...base, extraPorts }).success, false, JSON.stringify(extraPorts));
  }
});

test("Geyser gets Bedrock's UDP port, and that's the port Bedrock players use", () => {
  const server = { port: 25565, extraPorts: [] as ExtraPort[], modrinthProjects: [PORT_PRESETS.geyser.modrinth] };
  const { server: withPorts, added } = withPluginPorts(server, usedPorts([]));
  assert.deepEqual(added.map((entry) => `${entry.port}/${entry.protocol}`), ["19132/udp"]);
  assert.equal(bedrockPortOf(withPorts), 19132);
  assert.equal(bedrockPortOf({ port: 25565, extraPorts: [{ port: 19140, protocol: "udp", target: 19132, label: "bedrock" }] }), 19140, "any UDP port mapped to 19132 inside counts");
  assert.equal(bedrockPortOf({ port: 25565 }), undefined);
  assert.deepEqual(missingPresetPorts({ port: 25565 }, ["Geyser-Spigot.jar"]), ["geyser"]);
});
