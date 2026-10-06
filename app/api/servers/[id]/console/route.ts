import { NextRequest, NextResponse } from "next/server";
import { sendConsoleCommand } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { recordEvent } from "@/lib/store";
import { commandSchema, consoleCommandForLog } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** Commands can op players or change the world, so each one is logged with who sent it (recorded after it's sent, once the server is known to exist). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { command } = commandSchema.parse(await request.json());
    const id = (await context.params).id;
    const output = await sendConsoleCommand(id, command);
    await recordEvent(id, "console", `Console command: ${consoleCommandForLog(command)}`, "info");
    return NextResponse.json({ ok: true, output: output || "" });
  } catch (error) { return apiError(error); }
}
