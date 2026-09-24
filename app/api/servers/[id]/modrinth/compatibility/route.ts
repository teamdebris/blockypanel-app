import { NextRequest, NextResponse } from "next/server";
import { modrinthServerConfig } from "@/lib/docker";
import { incompatibleProjects } from "@/lib/modrinth";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { updateServerSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Which of the server's plugins or mods won't load with a different server type or Minecraft version. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const server = await modrinthServerConfig(assertServerId((await context.params).id));
    const shape = updateServerSchema.innerType().innerType().shape;
    const type = shape.type.parse(request.nextUrl.searchParams.get("type") || server.type);
    const version = shape.version.parse(request.nextUrl.searchParams.get("version") || server.version);
    return NextResponse.json({ incompatible: await incompatibleProjects(server.modrinthProjects, type, version) });
  } catch (error) { return apiError(error); }
}
