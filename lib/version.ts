import packageJson from "@/package.json";

/**
 * The panel's version, and the commit its image was built from. CI passes the commit in as
 * BLOCKY_BUILD; images built any other way report no commit ("local build").
 */
export function panelVersion() {
  const build = (process.env.BLOCKY_BUILD || "").trim().toLowerCase();
  return { version: packageJson.version, commit: /^[0-9a-f]{7,40}$/.test(build) ? build.slice(0, 7) : undefined };
}
