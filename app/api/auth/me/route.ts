import { NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-server";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";

export async function GET() {
  try {
    const viewer = await requireViewer();
    return NextResponse.json({ username: viewer.username, role: viewer.role, recovery: viewer.recovery, demo: process.env.BLOCKY_DEMO === "true" });
  } catch (error) { return apiError(error); }
}
