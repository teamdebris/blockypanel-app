import { NextResponse } from "next/server";
import { startCopy } from "@/lib/offsite";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";
/** Copies every server now, in the background. */
export async function POST() { try { return NextResponse.json(await startCopy(), { status: 202 }); } catch (error) { return apiError(error); } }
