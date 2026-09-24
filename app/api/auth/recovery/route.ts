import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { signIn } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { serialized } from "@/lib/rate-limit";
import { apiError } from "@/lib/responses";
import { recoveryConfigured, recoveryPasswordMatches, recoveryPasswordProblem } from "@/lib/session";
import { recoverySchema } from "@/lib/validation";

export const runtime = "nodejs";

/** A one-hour admin session from BLOCKY_ADMIN_PASSWORD, for a forgotten password or a locked-out admin. */
export async function POST(request: Request) {
  try {
    const { password } = recoverySchema.parse(await request.json());
    if (!recoveryConfigured()) throw new HttpError(404, recoveryPasswordProblem() ? `Recovery sign-in is turned off: ${recoveryPasswordProblem()}` : "Recovery sign-in is turned off on this panel (BLOCKY_ADMIN_PASSWORD is empty).");
    // No lockout, so nobody can lock the owner out of recovery. Checks run one at a time with a delay
    // after each failure, and the password must be long, which keeps guessing impractical.
    const matches = await serialized("recovery", async () => {
      if (recoveryPasswordMatches(password)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return false;
    }).catch(() => { throw new HttpError(429, "Too many recovery attempts at once. Try again in a moment."); });
    if (!matches) return NextResponse.json({ error: "Incorrect recovery password." }, { status: 401 });
    const store = await accounts();
    if (!store.hasActiveAdmin()) return NextResponse.json({ setup: true });
    store.audit("Recovery", "Signed in with the recovery password");
    return await signIn(NextResponse.json({ ok: true }), request, { userId: null, recovery: true, persistent: false });
  } catch (error) { return apiError(error); }
}
