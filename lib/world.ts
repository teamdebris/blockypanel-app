/** Pure helpers for re-rolling a Minecraft world: which folders to delete and how to set the seed. */

/**
 * The world's folder name from server.properties (`level-name`, "world" by default). Only a plain
 * folder name is accepted, since the result is deleted recursively.
 */
export function levelName(properties: string) {
  const line = properties.split(/\r?\n/).find((entry) => /^\s*level-name\s*=/.test(entry));
  const value = line ? line.slice(line.indexOf("=") + 1).trim() : "";
  if (!value) return "world";
  if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(value) || value === "." || value === ".." || value.includes("..")) {
    throw new Error(`level-name "${value}" isn't a plain folder name, so the panel won't delete it. Delete the world folder by hand instead.`);
  }
  return value;
}

/** Paper and Purpur keep the Nether and End in sibling folders; vanilla keeps them inside the world. */
export function worldFolders(level: string) {
  return [level, `${level}_nether`, `${level}_the_end`];
}

/** Sets `key=value` in a server.properties text, replacing the line or appending it. */
export function withProperty(properties: string, key: string, value: string) {
  const newline = properties.includes("\r\n") ? "\r\n" : "\n";
  const lines = properties ? properties.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const index = lines.findIndex((line) => line.trim().split("=", 1)[0].trim() === key && !line.trimStart().startsWith("#"));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  return `${lines.join(newline)}${newline}`;
}

/** Seeds end up as a line in server.properties, so control characters (line breaks) aren't allowed. */
export function isSafeSeed(seed: string) {
  return !/[\u0000-\u001f\u007f]/.test(seed);
}
