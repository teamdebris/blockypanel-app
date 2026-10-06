import { NextResponse } from "next/server";
import { configureOffsite, disableOffsite, offsiteOverview, updateOffsite } from "@/lib/offsite";
import { apiError } from "@/lib/responses";
import { offsiteSetupSchema, offsiteUpdateSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await offsiteOverview()); } catch (error) { return apiError(error); } }
/** Sets up offsite backups, or moves them to another destination. Starts a first copy. */
export async function PUT(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await configureOffsite(offsiteSetupSchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
/** Changes the schedule, retention, or passphrase. */
export async function PATCH(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await updateOffsite(offsiteUpdateSchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
/** Stops copying; copies already made stay at the destination. */
export async function DELETE(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { await disableOffsite(); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
