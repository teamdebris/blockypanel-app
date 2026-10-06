import { NextResponse } from "next/server";
import { checkIn, cloudOverview, unlink } from "@/lib/cloud";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await cloudOverview()); } catch (error) { return apiError(error); } }
/** Checks in now instead of waiting for the next scheduled check-in. */
export async function POST(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { await checkIn(); return NextResponse.json(await cloudOverview()); } catch (error) { return apiError(error); } }
/** Unlinks this panel from its Blocky Cloud account. */
export async function DELETE(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { await unlink(); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
