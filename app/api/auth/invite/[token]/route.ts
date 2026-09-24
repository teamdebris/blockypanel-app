import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { signIn } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { ROLE_LABELS } from "@/lib/roles";
import { acceptInviteSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };
const EXPIRED = "This link has expired or was already used. Ask an admin for a new one.";

/** What the link is for, so the page can say "Alex invited you as an Operator". */
// Not rate-limited: tokens are 256 random bits, so guessing one isn't feasible, and counting misses
// would only give an attacker another way to trip the sign-in limits.
export async function GET(_: Request, context: Context) {
  try {
    const invite = (await accounts()).inviteForToken((await context.params).token);
    if (!invite) throw new HttpError(410, EXPIRED);
    return NextResponse.json({ kind: invite.kind, role: invite.role, roleLabel: invite.role ? ROLE_LABELS[invite.role] : undefined, invitedBy: invite.createdBy, username: invite.username, expiresAt: invite.expiresAt });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { username, password } = acceptInviteSchema.parse(await request.json());
    const store = await accounts();
    const invite = store.inviteForToken((await context.params).token);
    if (!invite) throw new HttpError(410, EXPIRED);
    const user = await store.acceptInvite((await context.params).token, password, username);
    store.audit(user.username, invite.kind === "invite" ? `Joined as ${ROLE_LABELS[user.role]} (invited by ${invite.createdBy})` : "Set a new password from a reset link");
    return await signIn(NextResponse.json({ ok: true }), request, { userId: user.id, persistent: true });
  } catch (error) { return apiError(error); }
}
