// Each server's picture: a block or a mob head, drawn in Blocky's faceted cube style (public/brand/blocks/).
// The chests aren't here: they stand for backups.

export const SERVER_ICONS = ["grass", "dirt", "stone", "sand", "snow", "water", "oak-log", "copper-ore", "creeper", "zombie", "skeleton", "enderman", "pig", "cow", "sheep", "villager"] as const;
export type ServerIcon = (typeof SERVER_ICONS)[number];

export const SERVER_ICON_LABELS: Record<ServerIcon, string> = {
  grass: "Grass", dirt: "Dirt", stone: "Stone", sand: "Sand", snow: "Snow", water: "Water", "oak-log": "Oak log", "copper-ore": "Copper ore",
  creeper: "Creeper", zombie: "Zombie", skeleton: "Skeleton", enderman: "Enderman", pig: "Pig", cow: "Cow", sheep: "Sheep", villager: "Villager",
};

const BLOCKS = SERVER_ICONS.slice(0, 8);

export function isServerIcon(value: unknown): value is ServerIcon {
  return typeof value === "string" && (SERVER_ICONS as readonly string[]).includes(value);
}

/** A server that hasn't picked one gets a block from its ID, so it looks the same everywhere and never blank. */
export function serverIcon(server: { id: string; icon?: string }): ServerIcon {
  if (isServerIcon(server.icon)) return server.icon;
  let hash = 0;
  for (const char of server.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BLOCKS[hash % BLOCKS.length];
}

// Obsidian stands for Blocky Cloud's "Obsidian backups": the block a creeper can't blow up.
export const blockArt = (name: ServerIcon | "chest-storage" | "chest-ender" | "chest-shulker" | "obsidian") => `/brand/blocks/${name}.svg`;
