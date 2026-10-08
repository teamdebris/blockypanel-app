/** Parses `list` output: "There are 2 of a max of 20 players online: Steve, Alex" (and the older "2/20" form). */
export function parsePlayerList(output: string) {
  const count = Number(/There are (\d+)/i.exec(output)?.[1] || 0);
  const names = (output.split(":").slice(1).join(":") || "").split(/[,\n]/).map((name) => name.replace(/§./g, "").trim()).filter((name) => /^[A-Za-z0-9_]{1,16}$/.test(name));
  return { online: Math.max(count, names.length), names };
}

/**
 * The online count from `mc-monitor status --json`. It nests the server's reply under
 * `server_info` ({"server_info": {"players": {"online": 2}}}); older versions put `players` at the top.
 */
export function parseStatusCount(json: string) {
  const status = JSON.parse(json) as { server_info?: { players?: { online?: unknown } }; players?: { online?: unknown } };
  const online = Number(status.server_info?.players?.online ?? status.players?.online ?? 0);
  return Number.isFinite(online) && online > 0 ? Math.floor(online) : 0;
}

/**
 * The Minecraft version from `mc-monitor status --json`, for servers set to LATEST or SNAPSHOT.
 * Servers report a name like "Paper 1.21.8" or just "1.21.8"; proxies and some plugins report
 * something else entirely, which gives undefined.
 */
export function parseStatusVersion(json: string) {
  const status = JSON.parse(json) as { server_info?: { version?: { name?: unknown } }; version?: { name?: unknown } };
  const name = status.server_info?.version?.name ?? status.version?.name;
  if (typeof name !== "string") return undefined;
  return /(?:^|\s)(\d+\.\d+(?:\.\d+)?|\d{2}w\d{2}[a-z])(?:\s|$)/.exec(name.trim())?.[1];
}
