import { NextResponse } from "next/server";
import { configureOffsite, disableOffsite, offsiteOverview, updateOffsite } from "@/lib/offsite";
import { apiError } from "@/lib/responses";
import { offsiteSetupSchema, offsiteUpdateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function GET() { try { return NextResponse.json(await offsiteOverview()); } catch (error) { return apiError(error); } }
/** Sets up offsite backups, or moves them to another destination. Starts a first copy. */
export async function PUT(request: Request) { try { return NextResponse.json(await configureOffsite(offsiteSetupSchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
/** Changes the schedule, retention, or passphrase. */
export async function PATCH(request: Request) { try { return NextResponse.json(await updateOffsite(offsiteUpdateSchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
/** Stops copying; copies already made stay at the destination. */
export async function DELETE() { try { await disableOffsite(); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
