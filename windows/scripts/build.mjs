// Builds Blocky Panel for Windows: the server bundle, the web UI, and (unless --no-exe) one
// BlockyPanel.exe made with Node's single executable applications feature.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const web = path.join(dist, "web");
const makeExe = !process.argv.includes("--no-exe");
if (makeExe && (process.platform !== "win32" || process.arch !== "x64")) {
  throw new Error("Build the Windows x64 executable on Windows x64 with Node.js 24.");
}
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node.js 24 to build the Windows application.");

rmSync(dist, { recursive: true, force: true });
mkdirSync(web, { recursive: true });

// The server: one CommonJS file (single executables need CommonJS).
await build({ entryPoints: [path.join(root, "src/server/main.ts")], outfile: path.join(dist, "server.cjs"), bundle: true, platform: "node", target: "node24", format: "cjs", minify: true, legalComments: "none", external: ["node:sea"] });

// The UI.
await build({ entryPoints: [path.join(root, "src/web/main.tsx")], outfile: path.join(web, "app.js"), bundle: true, format: "esm", target: "es2022", minify: true, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, legalComments: "none" });
execFileSync(process.execPath, [path.join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", path.join(root, "src/web/app.css"), "-o", path.join(web, "app.css"), "--minify"], { cwd: root, stdio: "inherit" });
copyFileSync(path.join(root, "src/web/index.html"), path.join(web, "index.html"));
copyFileSync(path.join(root, "src/web/theme.js"), path.join(web, "theme.js"));
copyFileSync(path.join(root, "assets/favicon.svg"), path.join(web, "favicon.svg"));
mkdirSync(path.join(web, "brand"), { recursive: true });
for (const name of ["blocky-panel-mark-light.svg", "blocky-panel-mark-dark.svg"]) copyFileSync(path.join(root, "assets", name), path.join(web, "brand", name));
cpSync(path.join(root, "assets/blocks"), path.join(web, "blocks"), { recursive: true });

if (makeExe) {
  // Every UI file is embedded in the executable, served with node:sea's getAsset().
  const assets = {};
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else assets[path.relative(web, full).replaceAll("\\", "/")] = full; } };
  walk(web);
  const config = path.join(dist, "sea-config.json");
  const blob = path.join(dist, "sea-prep.blob");
  writeFileSync(config, JSON.stringify({ main: path.join(dist, "server.cjs"), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
  const exe = path.join(dist, "BlockyPanel.exe");
  copyFileSync(process.execPath, exe);
  execFileSync(process.execPath, [path.join(root, "node_modules/postject/dist/cli.js"), exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });
  console.log(`\nBuilt ${path.relative(root, exe)} (${(statSync(exe).size / 1024 ** 2).toFixed(1)} MB) with ${Object.keys(assets).length} embedded files.`);
}
