import "server-only";

import type Docker from "dockerode";
import type { HostConfig } from "dockerode";

/**
 * Game containers run plugins and mods, which is someone else's code. They get their own bridge
 * network with container-to-container traffic off, so a bad mod can't reach the other servers or
 * the panel's network, and only the Linux capabilities the image needs to start (checked against
 * itzg/minecraft-server: first start, a plugin download, RCON, and a clean stop).
 *
 * The panel never talks to a game over the network (RCON and status run inside the container
 * through docker exec), and published game ports work from any network, so nothing else changes.
 * Internet access stays on: servers download their software, plugins, and mods.
 * BLOCKY_ISOLATE_SERVERS=false turns this off.
 */
export const GAME_NETWORK = "blocky-games";
const CAPABILITIES = ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"];

export const isolateServers = () => process.env.BLOCKY_ISOLATE_SERVERS !== "false";

/** Extra HostConfig for a game container: its network and capabilities. */
export function gameHostConfig(): Partial<HostConfig> {
  if (!isolateServers()) return {};
  return { NetworkMode: GAME_NETWORK, CapDrop: ["ALL"], CapAdd: CAPABILITIES };
}

let ready: Promise<void> | undefined;

/** Makes the game network once per process; a failed attempt is retried next time. */
export function ensureGameNetwork(docker: Docker) {
  if (!isolateServers()) return Promise.resolve();
  ready ??= (async () => {
    const existing = await docker.listNetworks({ filters: { name: [GAME_NETWORK] } });
    if (existing.some((network) => network.Name === GAME_NETWORK)) return;
    await docker.createNetwork({
      Name: GAME_NETWORK, Driver: "bridge", CheckDuplicate: true,
      Options: { "com.docker.network.bridge.enable_icc": "false" },
      Labels: { "panel.managed": "true" },
    }).catch(async (error) => {
      // Another panel process made it first.
      if (!(await docker.listNetworks({ filters: { name: [GAME_NETWORK] } })).some((network) => network.Name === GAME_NETWORK)) throw error;
    });
  })().catch((error) => { ready = undefined; throw error; });
  return ready;
}
