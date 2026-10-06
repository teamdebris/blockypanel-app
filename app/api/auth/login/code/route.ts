import { NextResponse } from "next/server";
import { isWrongCredential } from "@/lib/account-store";
import { accounts } from "@/lib/auth";
import { fromAddress, signIn } from "@/lib/auth-server";
import { readJson } from "@/lib/json-body";
import { beginCodeAttempt, clientKey, codeRetryAfter, failuresToRecord, forgiveLogin } from "@/lib/rate-limit";
import { apiError, tooManyAttempts } from "@/lib/responses";
import { loginCodeSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** The second sign-in step: an authenticator code or a recovery code. */
export async function POST(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { challenge, code } = loginCodeSchema.parse(await readJson(request));
    const store = await accounts();
    const client = clientKey(request.headers);
    // Wrong codes count against the account (and address), not just this challenge: a new
    // challenge from repeating the password doesn't reset them.
    const pending = store.loginChallengeUser(challenge);
    const wait = pending ? codeRetryAfter(client, pending.id) : 0;
    if (wait) return tooManyAttempts(Math.ceil(wait / 1000));
    const attempt = pending ? beginCodeAttempt(client, pending.id) : undefined;
    let result: ReturnType<typeof store.completeLoginChallenge>;
    try { result = store.completeLoginChallenge(challenge, code); }
    catch (error) {
      if (!isWrongCredential(error)) attempt?.cancel();
      else if (pending) {
        const count = failuresToRecord(`code:${pending.id}`);
        if (count) store.audit(pending.username, `Entered a wrong two-factor code${count > 1 ? ` (${count} times)` : ""}${fromAddress(request)}`);
      }
      // The delay slows scripted guessing further.
      await new Promise((resolve) => setTimeout(resolve, 750));
      throw error;
    }
    attempt?.succeed();
    forgiveLogin(client, result.user.username);
    store.audit(result.user.username, result.usedRecoveryCode ? `Signed in with a recovery code (${result.recoveryCodesLeft} left)${fromAddress(request)}` : `Signed in${fromAddress(request)}`);
    return await signIn(NextResponse.json({ ok: true, recoveryCodesLeft: result.usedRecoveryCode ? result.recoveryCodesLeft : undefined }), request, { userId: result.user.id, persistent: result.persistent });
  } catch (error) { return apiError(error, { publicRoute: true }); }
}
