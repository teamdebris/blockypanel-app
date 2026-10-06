import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { fromAddress, signIn } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { readJson } from "@/lib/json-body";
import { withCheckSlot } from "@/lib/rate-limit";
import { apiError, busy } from "@/lib/responses";
import { ROLE_LABELS } from "@/lib/roles";
import { acceptInviteSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };
const EXPIRED = "This link has expired or was already used. Ask an admin for a new one.";

/** What the link is for, so the page can say "Alex invited you as an Operator". */
// Not rate-limited: tokens are 256 random bits, so guessing one isn't feasible, and counting misses
// would only give an attacker another way to trip the sign-in limits.
export async function GET(request: Request, context: Context) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const invite = (await accounts()).inviteForToken((await context.params).token);
    if (!invite) throw new HttpError(410, EXPIRED);
    return NextResponse.json({ kind: invite.kind, role: invite.role, roleLabel: invite.role ? ROLE_LABELS[invite.role] : undefined, invitedBy: invite.createdBy, username: invite.username, expiresAt: invite.expiresAt });
  } catch (error) { return apiError(error, { publicRoute: true }); }
}

export async function POST(request: Request, context: Context) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { username, password } = acceptInviteSchema.parse(await readJson(request));
    const store = await accounts();
    const token = (await context.params).token;
    const invite = store.inviteForToken(token);
    if (!invite) throw new HttpError(410, EXPIRED);
    const accepted = await withCheckSlot(() => store.acceptInvite(token, password, username));
    if (!accepted) return busy();
    const { user, challenge } = accepted;
    store.audit(user.username, invite.kind === "invite" ? `Joined as ${ROLE_LABELS[user.role]} (invited by ${invite.createdBy})` : `Set a new password from a reset link${fromAddress(request)}`);
    // A reset doesn't skip two-factor sign-in: the new password only earns the code step, as at login.
    if (challenge) return NextResponse.json({ twoFactor: true, challenge });
    return await signIn(NextResponse.json({ ok: true }), request, { userId: user.id, persistent: true });
  } catch (error) { return apiError(error, { publicRoute: true }); }
}
