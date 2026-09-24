import { NextResponse } from "next/server";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { getServerControl } from "@/lib/store";

export const runtime = "nodejs";
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) { try { return NextResponse.json({ events: (await getServerControl(assertServerId((await context.params).id))).events }); } catch (error) { return apiError(error); } }
