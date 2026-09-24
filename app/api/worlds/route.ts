import { NextResponse } from "next/server";
import { listDetachedWorlds } from "@/lib/docker";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";
export async function GET() { try { return NextResponse.json({ worlds: await listDetachedWorlds() }); } catch (error) { return apiError(error); } }
