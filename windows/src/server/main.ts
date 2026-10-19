import { execFile } from "node:child_process";
import { createServer, VERSION } from "./http";
import { stopAll } from "./minecraft";
import { DATA_ROOT } from "./paths";

const FIRST_PORT = Number(process.env.BLOCKY_PORT) || 3080;

/** Listens on 127.0.0.1 only, trying the next port if one is taken. */
async function listen(port: number, tries = 10): Promise<{ port: number; server: ReturnType<typeof createServer> }> {
  const server = createServer(port);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
    return { port, server };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && tries > 1) return listen(port + 1, tries - 1);
    throw error;
  }
}

async function main() {
  const { port, server } = await listen(FIRST_PORT);
  const url = `http://127.0.0.1:${port}`;
  console.log("");
  console.log(`  Blocky Panel ${VERSION} for Windows`);
  console.log(`  Open ${url} in your browser.`);
  console.log(`  Servers and backups are kept in ${DATA_ROOT}`);
  console.log("  Close this window, or press Ctrl+C, to stop Blocky and its servers.");
  console.log("");
  if (process.env.BLOCKY_NO_BROWSER !== "1") execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, () => undefined);

  // Closing the window or Ctrl+C: save and stop every server first, so no world is cut off mid-write.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("  Stopping servers…");
    server.close();
    await stopAll(8_000);
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, () => void shutdown());
}

main().catch((error) => {
  console.error("Blocky Panel couldn't start:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
