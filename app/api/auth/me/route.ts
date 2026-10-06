import { NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const viewer = await requireViewer();
    return NextResponse.json({ username: viewer.username, role: viewer.role, recovery: viewer.recovery, demo: process.env.BLOCKY_DEMO === "true" });
  } catch (error) { return apiError(error); }
}
