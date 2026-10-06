import { NextRequest, NextResponse } from "next/server";
import { accounts, viewerForToken } from "@/lib/auth";
import { clearedCookie, COOKIE_NAME } from "@/lib/session";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const store = await accounts();
    const viewer = await viewerForToken(token);
    store.deleteSessionByToken(token);
    if (viewer) store.audit(viewer.username, "Signed out");
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, "", clearedCookie);
  return response;
}
