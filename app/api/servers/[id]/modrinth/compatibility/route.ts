import { NextRequest, NextResponse } from "next/server";
import { modrinthServerConfig } from "@/lib/docker";
import { incompatibleProjects } from "@/lib/modrinth";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { serverFields } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** Which of the server's plugins or mods won't load with a different server type or Minecraft version. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const server = await modrinthServerConfig(assertServerId((await context.params).id));
    const type = serverFields.type.parse(request.nextUrl.searchParams.get("type") || server.type);
    const version = serverFields.version.parse(request.nextUrl.searchParams.get("version") || server.version);
    return NextResponse.json({ incompatible: await incompatibleProjects(server.modrinthProjects, type, version) });
  } catch (error) { return apiError(error); }
}
