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
