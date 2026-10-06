import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(path.join(standalone, "server.js"))) {
  throw new Error("No production build found. Run npm run build first.");
}

cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true, force: true });
mkdirSync(path.join(standalone, ".next"), { recursive: true });
cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true, force: true });

process.env.HOSTNAME ??= "0.0.0.0";
process.env.PORT ??= "3000";
await import(pathToFileURL(path.join(standalone, "server.js")).href);
