import { NextRequest, NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** Your own sessions ("where you're signed in"). */
export async function GET(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const viewer = await requireViewer();
    const sessions = viewer.userId ? (await accounts()).listSessions(viewer.userId) : [];
    return NextResponse.json({ sessions: sessions.map((session) => ({ id: session.id, current: session.id === viewer.sessionId, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, userAgent: session.userAgent, ip: session.ip, persistent: session.persistent })) });
  } catch (error) { return apiError(error); }
}

/** ?id=<session> signs out one of your sessions; without it, every session except this one. */
export async function DELETE(request: NextRequest) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const viewer = await requireViewer();
    if (!viewer.userId) return NextResponse.json({ ok: true });
    const store = await accounts();
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      store.deleteSession(id, viewer.userId);
      store.audit(viewer.username, id === viewer.sessionId ? "Signed out" : "Signed out another device");
    } else {
      store.deleteUserSessions(viewer.userId, viewer.sessionId);
      store.audit(viewer.username, "Signed out everywhere else");
    }
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
