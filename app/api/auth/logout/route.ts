import { NextRequest, NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { clearedCookie, COOKIE_NAME } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) (await accounts()).deleteSessionByToken(token);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, "", clearedCookie);
  return response;
}
