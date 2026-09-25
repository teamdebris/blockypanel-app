import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { signIn } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";
import { loginCodeSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** The second sign-in step: an authenticator code or a recovery code. */
export async function POST(request: Request) {
  try {
    const { challenge, code } = loginCodeSchema.parse(await request.json());
    const store = await accounts();
    let result: ReturnType<typeof store.completeLoginChallenge>;
    try { result = store.completeLoginChallenge(challenge, code); }
    catch (error) {
      // Each challenge allows only a few codes; the delay slows scripted guessing further.
      await new Promise((resolve) => setTimeout(resolve, 750));
      throw error;
    }
    if (result.usedRecoveryCode) store.audit(result.user.username, `Signed in with a recovery code (${result.recoveryCodesLeft} left)`);
    return await signIn(NextResponse.json({ ok: true, recoveryCodesLeft: result.usedRecoveryCode ? result.recoveryCodesLeft : undefined }), request, { userId: result.user.id, persistent: result.persistent });
  } catch (error) { return apiError(error); }
}
