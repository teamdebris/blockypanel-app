import { NextResponse } from "next/server";
import { listServerOffsiteSnapshots, restoreServerSnapshot } from "@/lib/offsite";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { offsiteSnapshotRestoreSchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) { try { return NextResponse.json({ snapshots: await listServerOffsiteSnapshots(assertServerId((await context.params).id)) }); } catch (error) { return apiError(error); } }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { snapshot } = offsiteSnapshotRestoreSchema.parse(await request.json());
    return NextResponse.json(await restoreServerSnapshot(assertServerId((await context.params).id), snapshot), { status: 202 });
  } catch (error) { return apiError(error); }
}
