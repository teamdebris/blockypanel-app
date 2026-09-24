/** Parses `list` output: "There are 2 of a max of 20 players online: Steve, Alex" (and the older "2/20" form). */
export function parsePlayerList(output: string) {
  const count = Number(/There are (\d+)/i.exec(output)?.[1] || 0);
  const names = (output.split(":").slice(1).join(":") || "").split(/[,\n]/).map((name) => name.replace(/§./g, "").trim()).filter((name) => /^[A-Za-z0-9_]{1,16}$/.test(name));
  return { online: Math.max(count, names.length), names };
}
