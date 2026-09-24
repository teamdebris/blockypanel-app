import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { signIn } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { serialized } from "@/lib/rate-limit";
import { apiError } from "@/lib/responses";
import { recoveryConfigured, recoveryPasswordMatches, recoveryPasswordProblem } from "@/lib/session";
import { setupSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * Setup needs BLOCKY_ADMIN_PASSWORD, which proves the person owns the machine; otherwise whoever
 * found a fresh install first could claim it. A development install without one can skip it.
 */
function setupPasswordRequired() {
  return Boolean(process.env.BLOCKY_ADMIN_PASSWORD) || process.env.NODE_ENV === "production";
}

export async function GET() {
  try {
    const needsSetup = !(await accounts()).hasActiveAdmin();
    return NextResponse.json({ needsSetup, setupPasswordRequired: setupPasswordRequired(), setupPasswordConfigured: recoveryConfigured(), setupPasswordProblem: recoveryPasswordProblem(), recoveryAvailable: recoveryConfigured(), demo: process.env.BLOCKY_DEMO === "true" });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const { setupPassword, username, password } = setupSchema.parse(await request.json());
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
    const user = await store.createFirstAdmin(username, password);
    store.audit(user.username, "Set up Blocky and created the first admin account");
    return await signIn(NextResponse.json({ ok: true }), request, { userId: user.id, persistent: true });
  } catch (error) { return apiError(error); }
}
