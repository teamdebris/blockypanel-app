import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const viewer = await requireViewer("admin");
    const store = await accounts();
    store.revokeInvite((await context.params).id);
    store.audit(viewer.username, "Revoked a pending link");
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
