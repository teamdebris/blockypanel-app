import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";
import { ROLE_LABELS } from "@/lib/roles";
import { inviteSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    const viewer = await requireViewer("admin");
    const store = await accounts();
    return NextResponse.json({
      users: store.listUsers().map((user) => ({ ...user, you: user.id === viewer.userId })),
      invites: store.listInvites(),
      audit: store.listAudit(40),
    });
  } catch (error) { return apiError(error); }
}

/** Creates an invite link. The token is returned once and only its hash is stored. */
export async function POST(request: Request) {
  try {
    const viewer = await requireViewer("admin");
    const { role } = inviteSchema.parse(await request.json());
    const store = await accounts();
    const { token, invite } = store.createInvite(role, viewer.username);
    store.audit(viewer.username, `Created an invite for a new ${ROLE_LABELS[role]}`);
    return NextResponse.json({ token, invite }, { status: 201 });
  } catch (error) { return apiError(error); }
}
