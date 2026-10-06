import { NextResponse } from "next/server";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { getServerControl } from "@/lib/store";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json({ events: (await getServerControl(assertServerId((await context.params).id))).events }); } catch (error) { return apiError(error); } }
