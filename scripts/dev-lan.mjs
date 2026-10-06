import { spawn } from "node:child_process";

// In development, first-run setup doesn't ask for BLOCKY_ADMIN_PASSWORD when none is set, so on the
// network anyone could claim a fresh install (and with it, control of Docker). Require a real one.
const password = process.env.BLOCKY_ADMIN_PASSWORD || "";
if ((password.length < 16 || /^replace-with/i.test(password)) && process.env.BLOCKY_DEMO !== "true") {
  console.error("Refusing to listen on the network without a BLOCKY_ADMIN_PASSWORD of at least 16 characters. Set one, use BLOCKY_DEMO=true, or run `npm run dev` for localhost only.");
  process.exit(1);
}

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
