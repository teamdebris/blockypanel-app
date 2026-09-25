import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { signIn } from "@/lib/auth-server";
import { beginLoginAttempt, clientKey, loginRetryAfter, withCheckSlot } from "@/lib/rate-limit";
import { apiError } from "@/lib/responses";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";

function tooMany(retryAfter: number) {
  return NextResponse.json({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? "s" : ""}.`, retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}

export async function POST(request: Request) {
  try {
    const { username, password, remember } = loginSchema.parse(await request.json());
    const client = clientKey(request.headers);
    const wait = loginRetryAfter(client, username);
    if (wait) return tooMany(Math.ceil(wait / 1000));
    const store = await accounts();
    // Counted before the check, so a burst of parallel requests can't all get past the limit.
    const attempt = beginLoginAttempt(client, username);
    const checked = await withCheckSlot(async () => ({ user: await store.authenticate(username, password) }));
    if (!checked) {
      attempt.cancel();
      return NextResponse.json({ error: "The panel is busy checking other sign-ins. Try again in a few seconds." }, { status: 503, headers: { "Retry-After": "5" } });
    }
    const { user } = checked;
    if (!user) {
      attempt.fail();
      // Slows scripted guessing without affecting a person who mistyped.
      await new Promise((resolve) => setTimeout(resolve, 750));
      return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
    }
    attempt.succeed();
    // With two-factor on, the password only earns a few minutes to enter a code.
    if (user.twoFactor) return NextResponse.json({ twoFactor: true, challenge: store.createLoginChallenge(user.id, remember !== false) });
    return await signIn(NextResponse.json({ ok: true }), request, { userId: user.id, persistent: remember !== false });
  } catch (error) { return apiError(error); }
}
