import { NextRequest, NextResponse } from "next/server";
import { createServer, listServers } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { createServerSchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function GET() { try { return NextResponse.json({ servers: await listServers() }); } catch (error) { return apiError(error); } }
// Provisioning (image pull, first start) continues in the background; the server appears as "starting".
export async function POST(request: NextRequest) {
  try {
    const created = await createServer(createServerSchema.parse(await request.json()));
    return NextResponse.json(created, { status: 202 });
  } catch (error) { return apiError(error); }
}
