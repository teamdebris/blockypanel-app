import { NextRequest, NextResponse } from "next/server";
import { sendConsoleCommand } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { commandSchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) { try { const { command } = commandSchema.parse(await request.json()); const output = await sendConsoleCommand((await context.params).id, command); return NextResponse.json({ ok: true, output: output || "" }); } catch (error) { return apiError(error); } }
