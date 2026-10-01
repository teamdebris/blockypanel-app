/**
 * Extra ports a Minecraft server publishes beyond its game port: web maps, voice chat, and the like.
 * Pure (no Next.js or Docker), so the rules are unit-tested and shared by the server, the UI, and
 * validation. A port is published on the host when the panel creates the server's container, so
 * changing these recreates it, through the same safety-backup flow as any other setting.
 */

export type PortProtocol = "tcp" | "udp";
export type PortPresetId = "bluemap" | "voicechat";
/** `port` is on the host; `target` is where the plugin listens inside the container. */
export type ExtraPort = { port: number; protocol: PortProtocol; target: number; label: string; preset?: PortPresetId };

type ServerType = "PAPER" | "PURPUR" | "VANILLA" | "FABRIC" | "QUILT" | "FORGE" | "NEOFORGE";
type PortedServer = { port: number; gamePortUdp?: boolean; extraPorts?: ExtraPort[] };

export const MAX_EXTRA_PORTS = 10;
/** Inside every container: the game port and RCON. RCON is never published; it would hand out the console. */
const GAME_TARGET = 25565;
const RCON_TARGET = 25575;

export type PortPreset = {
  id: PortPresetId;
  label: string;
  /** Modrinth project ID, so a plugin added from the Plugins tab gets its port automatically. */
  modrinth: string;
  /** Jar file names that identify the plugin when it was added by hand. */
  jar: RegExp;
  target: number;
  protocol: PortProtocol;
  /**
   * A web map can sit behind any host port. A voice plugin tells players which port to use, so the
   * host port must be the same number the plugin listens on.
   */
  sameNumber: boolean;
  web: boolean;
  /** What the plugin needs in its own config for the port to work. */
  setup: (mods: boolean) => string;
};

/** The most used map and voice plugins on Modrinth, both loading on every server type the panel runs. */
export const PORT_PRESETS: Record<PortPresetId, PortPreset> = {
  bluemap: {
    id: "bluemap", label: "BlueMap web map", modrinth: "swbUV1cr", jar: /^bluemap[^/]*\.jar$/i, target: 8100, protocol: "tcp", sameNumber: false, web: true,
    setup: (mods) => `BlueMap only starts rendering after you set accept-download: true in ${mods ? "config/bluemap" : "plugins/BlueMap"}/core.conf.`,
  },
  voicechat: {
    id: "voicechat", label: "Simple Voice Chat", modrinth: "9eGKb6K1", jar: /^voicechat[^/]*\.jar$/i, target: 24454, protocol: "udp", sameNumber: true, web: false,
    setup: (mods) => `Its port is set in ${mods ? "config" : "plugins"}/voicechat/voicechat-server.properties; it must match the port here.`,
  },
};

export const portKey = (port: number, protocol: PortProtocol) => `${port}/${protocol}`;

/** Host ports the panel itself publishes: the web panel and SFTP. */
export function panelPorts(env: Record<string, string | undefined> = process.env) {
  const sftp = Number(env.BLOCKY_SFTP_PORT || 2022);
  return new Set([portKey(3000, "tcp"), ...(env.BLOCKY_SFTP === "false" || !Number.isInteger(sftp) ? [] : [portKey(sftp, "tcp")])]);
}

/** Every host port a server occupies, as "port/protocol". */
export function hostPortsOf(server: PortedServer) {
  return [portKey(server.port, "tcp"), ...(server.gamePortUdp ? [portKey(server.port, "udp")] : []), ...(server.extraPorts ?? []).map((entry) => portKey(entry.port, entry.protocol))];
}

/** Why a server's own ports don't work together, or undefined. */
export function ownPortProblem(server: PortedServer) {
  const extra = server.extraPorts ?? [];
  if (extra.length > MAX_EXTRA_PORTS) return `A server can have at most ${MAX_EXTRA_PORTS} extra ports.`;
  const seenHost = new Set<string>();
  const seenTarget = new Set<string>();
  for (const entry of extra) {
    if (entry.target === RCON_TARGET) return "Port 25575 is RCON, the server's console. It's never published.";
    if (entry.port === server.port) {
      return entry.protocol === "udp" ? `For UDP on the game port (${server.port}), turn on "Also open the game port for UDP" instead.` : `${server.port} is this server's game port.`;
    }
    if (entry.target === GAME_TARGET) return "Port 25565 inside the container is the game itself; it's published through the game port setting.";
    const host = portKey(entry.port, entry.protocol);
    const target = portKey(entry.target, entry.protocol);
    if (seenHost.has(host)) return `${entry.port}/${entry.protocol.toUpperCase()} is listed twice.`;
    if (seenTarget.has(target)) return `Two entries point at ${entry.target}/${entry.protocol.toUpperCase()} in the container.`;
    seenHost.add(host);
    seenTarget.add(target);
  }
  return undefined;
}

/**
 * The first port this server would take that's already in use, as a message, or undefined.
 * `used` maps "port/protocol" to whoever uses it (another server's name, or "the panel").
 */
export function portClash(server: PortedServer, used: Map<string, string>) {
  for (const key of hostPortsOf(server)) {
    const owner = used.get(key);
    if (owner) {
      const [port, protocol] = key.split("/");
      return `Port ${port}${protocol === "udp" ? " (UDP)" : ""} is already used by ${owner}.`;
    }
  }
  return undefined;
}

/** Ports in use by other servers and the panel, for clash checks and picking free ones. */
export function usedPorts(others: (PortedServer & { name: string })[], env?: Record<string, string | undefined>) {
  const used = new Map<string, string>();
  for (const key of panelPorts(env)) used.set(key, "the panel");
  for (const other of others) for (const key of hostPortsOf(other)) if (!used.has(key)) used.set(key, other.name);
  return used;
}

/** The preset a port belongs to: tagged, or matching a preset's container port and protocol. */
function presetOf(entry: ExtraPort) {
  if (entry.preset) return entry.preset;
  return (Object.values(PORT_PRESETS).find((preset) => preset.target === entry.target && preset.protocol === entry.protocol))?.id;
}

/** A preset's entry on a free host port, or why it can't be added. */
export function presetPort(id: PortPresetId, server: PortedServer, used: Map<string, string>): { entry: ExtraPort } | { problem: string } {
  const preset = PORT_PRESETS[id];
  const taken = (port: number) => used.has(portKey(port, preset.protocol)) || hostPortsOf(server).includes(portKey(port, preset.protocol));
  if (preset.sameNumber) {
    if (taken(preset.target)) {
      return { problem: `${preset.label} uses ${preset.target}/${preset.protocol.toUpperCase()}, which is already taken${used.get(portKey(preset.target, preset.protocol)) ? ` by ${used.get(portKey(preset.target, preset.protocol))}` : ""}. Pick another port in its config, then add that port here.` };
    }
    return { entry: { port: preset.target, protocol: preset.protocol, target: preset.target, label: preset.label, preset: id } };
  }
  for (let port = preset.target; port < preset.target + 100 && port < 65536; port += 1) {
    if (!taken(port)) return { entry: { port, protocol: preset.protocol, target: preset.target, label: preset.label, preset: id } };
  }
  return { problem: `No free port near ${preset.target} for ${preset.label}.` };
}

/**
 * Opens ports for map and voice plugins in the server's Modrinth list that don't have one yet.
 * Used when settings are applied, since that recreates the container anyway: a plugin added from the
 * Plugins tab works without a second restart. Ports are never removed here; a plugin added by hand
 * may still need its port after the Modrinth entry goes.
 */
export function withPluginPorts<T extends PortedServer & { modrinthProjects?: string[] }>(server: T, used: Map<string, string>) {
  const extraPorts = [...(server.extraPorts ?? [])];
  const added: ExtraPort[] = [];
  const skipped: { preset: PortPresetId; reason: string }[] = [];
  for (const preset of Object.values(PORT_PRESETS)) {
    if (!server.modrinthProjects?.includes(preset.modrinth)) continue;
    if (extraPorts.some((entry) => presetOf(entry) === preset.id)) continue;
    if (extraPorts.length >= MAX_EXTRA_PORTS) { skipped.push({ preset: preset.id, reason: `${preset.label}'s port wasn't opened: this server already has ${MAX_EXTRA_PORTS} extra ports.` }); continue; }
    const result = presetPort(preset.id, { ...server, extraPorts }, used);
    if ("problem" in result) { skipped.push({ preset: preset.id, reason: result.problem }); continue; }
    extraPorts.push(result.entry);
    added.push(result.entry);
  }
  return { server: { ...server, extraPorts }, added, skipped };
}

/** Map and voice plugins found on a server (by jar name or Modrinth list) whose port isn't open. */
export function missingPresetPorts(server: PortedServer & { modrinthProjects?: string[] }, jarNames: string[]) {
  return Object.values(PORT_PRESETS)
    .filter((preset) => server.modrinthProjects?.includes(preset.modrinth) || jarNames.some((name) => preset.jar.test(name)))
    .filter((preset) => !(server.extraPorts ?? []).some((entry) => presetOf(entry) === preset.id))
    .map((preset) => preset.id);
}

/** Whether plugins for this server type live in mods/ and config/ (mod loaders) rather than plugins/. */
export function usesMods(type: ServerType) {
  return ["FABRIC", "QUILT", "FORGE", "NEOFORGE"].includes(type);
}

/** Docker's ExposedPorts and PortBindings for a server: the game port, then the extras. */
export function portBindings(server: PortedServer) {
  const exposed: Record<string, Record<string, never>> = { [`${GAME_TARGET}/tcp`]: {} };
  const bindings: Record<string, { HostPort: string }[]> = { [`${GAME_TARGET}/tcp`]: [{ HostPort: String(server.port) }] };
  if (server.gamePortUdp) {
    exposed[`${GAME_TARGET}/udp`] = {};
    bindings[`${GAME_TARGET}/udp`] = [{ HostPort: String(server.port) }];
  }
  for (const entry of server.extraPorts ?? []) {
    const key = `${entry.target}/${entry.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(entry.port) }];
  }
  return { ExposedPorts: exposed, PortBindings: bindings };
}

/** Extra ports read back from a container label: anything malformed is dropped rather than trusted. */
export function parseExtraPorts(value: string | undefined): ExtraPort[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const valid = (port: unknown, min: number): port is number => Number.isInteger(port) && (port as number) >= min && (port as number) <= 65535;
  return parsed.flatMap((item): ExtraPort[] => {
    if (!item || typeof item !== "object") return [];
    const { port, protocol, target, label, preset } = item as Record<string, unknown>;
    if (!valid(port, 1024) || !valid(target ?? port, 1) || (protocol !== "tcp" && protocol !== "udp")) return [];
    return [{ port, protocol, target: (target ?? port) as number, label: typeof label === "string" ? label.slice(0, 40) : "", ...(preset === "bluemap" || preset === "voicechat" ? { preset } : {}) }];
  }).slice(0, MAX_EXTRA_PORTS);
}
