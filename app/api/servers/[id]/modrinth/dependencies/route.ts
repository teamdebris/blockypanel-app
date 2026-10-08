import { NextRequest, NextResponse } from "next/server";
import { modrinthServerConfig } from "@/lib/docker";
import { dependencyPlan } from "@/lib/modrinth";
import { effectiveVersion, isModrinthId, MAX_MODRINTH_PROJECTS } from "@/lib/modrinth-core";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/**
 * What the server will download for a list of projects (the saved list or unsaved edits): each one's
 * version, the dependencies that come with it, and anything that will stop it starting.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const server = await modrinthServerConfig(assertServerId((await context.params).id));
    const ids = [...new Set((request.nextUrl.searchParams.get("ids") || "").split(",").filter(isModrinthId))].slice(0, MAX_MODRINTH_PROJECTS);
    const optional = request.nextUrl.searchParams.get("optional") === "true";
    const gameVersion = effectiveVersion(server.version, server.runningVersion);
    return NextResponse.json({ gameVersion, ...(await dependencyPlan(ids, server.type, gameVersion, optional)) });
  } catch (error) { return apiError(error); }
}
