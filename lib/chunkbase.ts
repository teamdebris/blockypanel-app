/**
 * Links to Chunkbase's seed map, which shows where a world's villages, biomes, and structures are.
 * Each map version is named after the first Minecraft version it covers, so a server's version maps
 * to the newest one that isn't newer than it. Newer releases fall back to the latest one listed here,
 * and versions it can't read ("LATEST", snapshots) let Chunkbase pick its current version.
 */
const JAVA_MAPS = [
  "1.7", "1.8", "1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15", "1.16", "1.17", "1.18",
  "1.19", "1.19.3", "1.20", "1.21", "1.21.2", "1.21.4", "1.21.5", "1.21.6", "1.21.9",
  "26.1", "26.2", "26.3", "26.4",
];

function parts(version: string) {
  return /^\d+(\.\d+){0,2}$/.test(version) ? version.split(".").map(Number) : undefined;
}

function compare(a: number[], b: number[]) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Chunkbase's name for the map matching a Java server's version, like "java_1_21_6" for 1.21.8. */
export function chunkbasePlatform(version: string): string | undefined {
  const target = parts(version.trim());
  if (!target) return undefined;
  const match = JAVA_MAPS.filter((map) => compare(parts(map)!, target) <= 0).at(-1);
  return match ? `java_${match.replaceAll(".", "_")}` : undefined;
}

const LONG_MIN = BigInt("-9223372036854775808");
const LONG_MAX = BigInt("9223372036854775807");

/** A Minecraft seed: a whole number in Java's long range. Text seeds are hashed by the game, so only the number it reports is a seed here. */
export function isNumericSeed(seed: string) {
  if (!/^-?\d{1,19}$/.test(seed)) return false;
  const value = BigInt(seed);
  return value >= LONG_MIN && value <= LONG_MAX;
}

/** The seed map for a world, centered on spawn. */
export function chunkbaseUrl(seed: string, version: string) {
  const platform = chunkbasePlatform(version);
  const params = [`seed=${encodeURIComponent(seed)}`, ...(platform ? [`platform=${platform}`] : []), "dimension=overworld", "x=0", "z=0", "zoom=1"];
  return `https://www.chunkbase.com/apps/seed-map#${params.join("&")}`;
}

/** The number in the game's reply to /seed, like "Seed: [-4172144997902289642]". */
export function parseSeedReply(output: string): string | undefined {
  const seed = /Seed:\s*\[(-?\d+)\]/.exec(output)?.[1];
  return seed && isNumericSeed(seed) ? seed : undefined;
}
