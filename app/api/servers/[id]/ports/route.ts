import { NextResponse } from "next/server";
import { modrinthServerConfig, portsInUse } from "@/lib/docker";
import { jarFileNames } from "@/lib/modrinth";
import { modrinthTarget } from "@/lib/modrinth-core";
import { assertServerId } from "@/lib/paths";
import { missingPresetPorts, PORT_PRESETS, presetPort, usesMods } from "@/lib/ports";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/**
 * Map and voice plugins on this server whose port isn't open yet, found in its Modrinth list or by
 * jar name (for ones added by hand), each with a free port to open it on or why there isn't one.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const id = assertServerId((await context.params).id);
    const server = await modrinthServerConfig(id);
    const target = modrinthTarget(server.type);
    const jars = target && process.env.BLOCKY_DEMO !== "true" ? await jarFileNames(id, target.folder) : [];
    const missing = missingPresetPorts(server, jars);
    const used = missing.length ? await portsInUse(id) : new Map<string, string>();
    return NextResponse.json({
      missing: missing.map((preset) => ({ preset, label: PORT_PRESETS[preset].label, setup: PORT_PRESETS[preset].setup(usesMods(server.type)), ...presetPort(preset, server, used) })),
    });
  } catch (error) { return apiError(error); }
}
