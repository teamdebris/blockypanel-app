import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { signIn } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { readJson } from "@/lib/json-body";
import { serialized, withCheckSlot } from "@/lib/rate-limit";
import { apiError, busy } from "@/lib/responses";
import { recoveryConfigured, recoveryPasswordMatches, recoveryPasswordProblem } from "@/lib/session";
import { setupSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/**
 * Setup needs BLOCKY_ADMIN_PASSWORD, which proves the person owns the machine; otherwise whoever
 * found a fresh install first could claim it. A development install without one can skip it.
 */
function setupPasswordRequired() {
  return Boolean(process.env.BLOCKY_ADMIN_PASSWORD) || process.env.NODE_ENV === "production";
}

export async function GET(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const needsSetup = !(await accounts()).hasActiveAdmin();
    // Why BLOCKY_ADMIN_PASSWORD is refused is only for whoever is setting the panel up; afterwards it stays in the server log.
    return NextResponse.json({ needsSetup, setupPasswordRequired: setupPasswordRequired(), setupPasswordConfigured: recoveryConfigured(), setupPasswordProblem: needsSetup ? recoveryPasswordProblem() : null, recoveryAvailable: recoveryConfigured(), demo: process.env.BLOCKY_DEMO === "true" });
  } catch (error) { return apiError(error, { publicRoute: true }); }
}

export async function POST(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { setupPassword, username, password } = setupSchema.parse(await readJson(request));
    if (setupPasswordRequired()) {
      if (!recoveryConfigured()) throw new HttpError(503, `${recoveryPasswordProblem() || "BLOCKY_ADMIN_PASSWORD isn't set."} Set a long random value in .env and restart the panel to finish setup.`);
      // One check at a time with a delay after a failure, like recovery; no lockout to abuse.
      const matches = await serialized("setup", async () => {
        if (recoveryPasswordMatches(setupPassword || "")) return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return false;
      }).catch(() => { throw new HttpError(429, "Too many setup attempts at once. Try again in a moment."); });
      if (!matches) return NextResponse.json({ error: "That isn't the BLOCKY_ADMIN_PASSWORD from .env.", field: "setupPassword" }, { status: 401 });
    }
    const store = await accounts();
    const user = await withCheckSlot(() => store.createFirstAdmin(username, password));
    if (!user) return busy();
    store.audit(user.username, "Set up Blocky and created the first admin account");
    return await signIn(NextResponse.json({ ok: true }), request, { userId: user.id, persistent: true });
  } catch (error) { return apiError(error, { publicRoute: true }); }
}
