export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "production" && process.env.BLOCKY_DEMO !== "true") {
    const { recoveryPasswordProblem } = await import("@/lib/session");
    const problem = recoveryPasswordProblem();
    if (problem) console.error(`${problem} First-run setup and recovery sign-in stay off until it's a long random value (e.g. openssl rand -base64 24).`);
    else if (!process.env.BLOCKY_ADMIN_PASSWORD) console.warn("BLOCKY_ADMIN_PASSWORD is not set: first-run setup can't finish, and recovery sign-in is off.");
    if (process.env.BLOCKY_COOKIE_SECURE !== "true" && process.env.BLOCKY_TRUST_PROXY !== "true") {
      console.warn("The panel isn't configured for HTTPS (BLOCKY_COOKIE_SECURE and BLOCKY_TRUST_PROXY are off). Passwords and sessions travel in plain text unless it's only reachable over a VPN or localhost. Put it behind an HTTPS reverse proxy; see the README.");
    }
  }
  await import("@/lib/scheduler");
}
