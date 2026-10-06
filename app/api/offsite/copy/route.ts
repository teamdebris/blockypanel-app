import { NextResponse } from "next/server";
import { startCopy } from "@/lib/offsite";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
/** Copies every server now, in the background. */
export async function POST(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await startCopy(), { status: 202 }); } catch (error) { return apiError(error); } }
