import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await requireViewer("admin");
    const store = await accounts();
    store.revokeInvite((await context.params).id);
    store.audit(viewer.username, "Revoked a pending link");
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
