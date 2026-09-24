import { NextResponse } from "next/server";
import { restoreFromOffsite } from "@/lib/offsite";
import { apiError } from "@/lib/responses";
import { offsiteRestoreSchema } from "@/lib/validation";

export const runtime = "nodejs";
/** Recreates the chosen servers from a destination, in the background. Progress shows in GET /api/offsite. */
export async function POST(request: Request) { try { return NextResponse.json(await restoreFromOffsite(offsiteRestoreSchema.parse(await request.json())), { status: 202 }); } catch (error) { return apiError(error); } }
