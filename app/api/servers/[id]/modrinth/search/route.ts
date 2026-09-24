import { NextRequest, NextResponse } from "next/server";
import { modrinthServerConfig } from "@/lib/docker";
import { searchProjects } from "@/lib/modrinth";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";

/** Modrinth search filtered to what this server can load. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const server = await modrinthServerConfig(assertServerId((await context.params).id));
    const query = (request.nextUrl.searchParams.get("q") || "").slice(0, 100);
    const offset = Math.max(0, Math.min(1000, Number(request.nextUrl.searchParams.get("offset")) || 0));
    return NextResponse.json(await searchProjects(query, server.type, server.version, offset));
  } catch (error) { return apiError(error); }
}
