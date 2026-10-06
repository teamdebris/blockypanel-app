import { NextResponse } from "next/server";
import { listDetachedWorlds } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json({ worlds: await listDetachedWorlds() }); } catch (error) { return apiError(error); } }
