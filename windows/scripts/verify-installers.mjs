// Optional network integration check. Downloads official Java/loaders, runs only their installers,
// and verifies Windows launch files. It never writes eula=true or starts a Minecraft game server.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Run installer verification on Windows x64.");
const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "blocky-installer-check-"));
process.env.BLOCKY_DATA = temporary;
const minecraft = process.argv[2] || "1.21.8";
const types = process.argv.slice(3).length ? process.argv.slice(3) : ["quilt", "forge", "neoforge"];
if (types.some((type) => !["quilt", "forge", "neoforge"].includes(type))) throw new Error("Choose quilt, forge, or neoforge.");
const result = await build({ stdin: { contents: "export { ensureJava, javaFor } from './src/server/software'; export { prepareLoader } from './src/server/loaders';", resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const core = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
try {
  const java = await core.ensureJava(await core.javaFor(minecraft), () => {});
  let count = 0;
  for (const software of types) {
    const id = String(++count).padStart(12, "0");
    await mkdir(path.join(temporary, "servers", id), { recursive: true });
    const tail = [];
    try {
      const args = await core.prepareLoader(software, minecraft, id, java, (line) => { tail.push(line); if (tail.length > 15) tail.shift(); }, (step) => console.log(step));
      const marker = JSON.parse(await readFile(path.join(temporary, "servers", id, ".blocky-loader.json"), "utf8"));
      console.log(JSON.stringify({ software, minecraft, loader: marker.loader, launchArgs: args, result: "installed" }));
    } catch (error) { console.error(`${software}: ${error instanceof Error ? error.message : String(error)}`); console.error(tail.join("\n")); process.exitCode = 1; }
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { await rm(temporary, { recursive: true, force: true }); }
