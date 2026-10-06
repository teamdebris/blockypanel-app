import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { fromAddress, signIn } from "@/lib/auth-server";
import { readJson } from "@/lib/json-body";
import { beginLoginAttempt, clientKey, codeRetryAfter, failuresToRecord, loginRetryAfter, withCheckSlot } from "@/lib/rate-limit";
import { apiError, busy, tooManyAttempts } from "@/lib/responses";
import { loginSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { username, password, remember } = loginSchema.parse(await readJson(request));
    const client = clientKey(request.headers);
    const wait = loginRetryAfter(client, username);
    if (wait) return tooManyAttempts(Math.ceil(wait / 1000));
    const store = await accounts();
    // Counted before the check, so a burst of parallel requests can't all get past the limit.
    const attempt = beginLoginAttempt(client, username);
    const checked = await withCheckSlot(async () => ({ user: await store.authenticate(username, password) }));
    if (!checked) {
      attempt.cancel();
      return busy("The panel is busy checking other sign-ins. Try again in a few seconds.");
    }
    const { user } = checked;
    if (!user) {
      attempt.fail();
      // Logged for real accounts only, at most once a minute each, so guessing can't flood the log.
      const known = store.findUser(username);
      const count = known ? failuresToRecord(`password:${known.id}`) : 0;
      if (known && count) store.audit(known.username, `Failed to sign in: wrong password${count > 1 ? ` (${count} times)` : ""}${fromAddress(request)}`);
      // Slows scripted guessing without affecting a person who mistyped.
      await new Promise((resolve) => setTimeout(resolve, 750));
      return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
    }
    if (user.twoFactor) {
      // The password alone doesn't forgive earlier failures: that waits for the code (login/code).
      attempt.cancel();
      // Wrong codes are limited per account, so a known password can't buy fresh guesses.
      const codeWait = codeRetryAfter(client, user.id);
      if (codeWait) return tooManyAttempts(Math.ceil(codeWait / 1000));
      // With two-factor on, the password only earns a few minutes to enter a code.
      return NextResponse.json({ twoFactor: true, challenge: store.createLoginChallenge(user.id, remember !== false) });
    }
    attempt.succeed();
    store.audit(user.username, `Signed in${fromAddress(request)}`);
    return await signIn(NextResponse.json({ ok: true }), request, { userId: user.id, persistent: remember !== false });
  } catch (error) { return apiError(error, { publicRoute: true }); }
}
