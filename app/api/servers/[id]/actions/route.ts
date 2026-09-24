import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-server";
import { runServerAction } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { actionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { action } = actionSchema.parse(await request.json());
    // Operators may start, stop, restart, and back up; a new image changes what runs, so it's admin-only.
    if (action === "update") await requireViewer("admin");
    const result = await runServerAction((await context.params).id, action);
    // Backups and updates run in the background and report through the server's operation state.
    return NextResponse.json(result, { status: "operation" in result ? 202 : 200 });
  } catch (error) { return apiError(error); }
}
