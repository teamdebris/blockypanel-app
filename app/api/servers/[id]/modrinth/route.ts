import { NextResponse } from "next/server";
import { modrinthServerConfig } from "@/lib/docker";
import { installedProjects } from "@/lib/modrinth";
import { modrinthTarget } from "@/lib/modrinth-core";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";

/** The server's Modrinth list, what's installed on disk, and other jars in plugins/ or mods/. */
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = assertServerId((await context.params).id);
    const server = await modrinthServerConfig(id);
    const target = modrinthTarget(server.type);
    const { projects, other } = await installedProjects(id, server, process.env.BLOCKY_DEMO === "true");
    return NextResponse.json({ target, type: server.type, version: server.version, projects, other });
  } catch (error) { return apiError(error); }
}
