import { NextResponse } from "next/server";
import { z } from "zod";
import { assertManagedServer, invalidateServerList } from "@/lib/docker";
import { listServerOffsiteSnapshots, restoreServerSnapshot } from "@/lib/offsite";
import { setServerOffsite } from "@/lib/offsite-settings";
import { recordEvent } from "@/lib/store";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { offsiteSnapshotRestoreSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json({ snapshots: await listServerOffsiteSnapshots(assertServerId((await context.params).id)) }); } catch (error) { return apiError(error); } }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { snapshot } = offsiteSnapshotRestoreSchema.parse(await request.json());
    return NextResponse.json(await restoreServerSnapshot(assertServerId((await context.params).id), snapshot), { status: 202 });
  } catch (error) { return apiError(error); }
}

/** { included } switches offsite copies on or off for this server. Copies already made are kept. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const id = assertServerId((await context.params).id);
    await assertManagedServer(id);
    const { included } = z.object({ included: z.boolean() }).parse(await request.json());
    await setServerOffsite(id, included);
    invalidateServerList();
    await recordEvent(id, "backup-offsite", included ? "Offsite copies were switched on." : "Offsite copies were switched off. Copies already made are kept.", "info");
    return NextResponse.json({ included });
  } catch (error) { return apiError(error); }
}
