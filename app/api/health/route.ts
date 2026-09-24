import { NextResponse } from "next/server";
import { getSystem } from "@/lib/docker";

export const runtime = "nodejs";
export async function GET() {
  const system = await getSystem();
  return NextResponse.json({ ok: true, dockerAvailable: system.dockerAvailable }, { status: system.dockerAvailable ? 200 : 503 });
}
