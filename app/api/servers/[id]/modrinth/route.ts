import { NextResponse } from "next/server";
import { modrinthServerConfig } from "@/lib/docker";
import { installedProjects } from "@/lib/modrinth";
import { effectiveVersion, modrinthTarget } from "@/lib/modrinth-core";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** The server's Modrinth list, what's installed on disk, and other jars in plugins/ or mods/. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const id = assertServerId((await context.params).id);
    const server = await modrinthServerConfig(id);
    const target = modrinthTarget(server.type);
    const { projects, other } = await installedProjects(id, { ...server, version: effectiveVersion(server.version, server.runningVersion) ?? server.version }, process.env.BLOCKY_DEMO === "true");
    return NextResponse.json({ target, type: server.type, version: server.version, runningVersion: server.runningVersion, projects, other });
  } catch (error) { return apiError(error); }
}
