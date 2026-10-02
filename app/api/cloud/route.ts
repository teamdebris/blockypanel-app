import { NextResponse } from "next/server";
import { checkIn, cloudOverview, unlink } from "@/lib/cloud";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";
export async function GET() { try { return NextResponse.json(await cloudOverview()); } catch (error) { return apiError(error); } }
/** Checks in now instead of waiting for the next scheduled check-in. */
export async function POST() { try { await checkIn(); return NextResponse.json(await cloudOverview()); } catch (error) { return apiError(error); } }
/** Unlinks this panel from its Blocky Cloud account. */
export async function DELETE() { try { await unlink(); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
