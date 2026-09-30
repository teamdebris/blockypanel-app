import { NextResponse } from "next/server";
import { assertManagedServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { clearScheduleFailures, recordEvent } from "@/lib/store";

export const runtime = "nodejs";

/** Dismisses the scheduled-backup failure warning. It comes back if the next scheduled backup fails too. */
export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await assertManagedServer(id);
    const cleared = await clearScheduleFailures(id);
    if (cleared) await recordEvent(id, "backup", `The scheduled backup warning was dismissed after ${cleared} failure${cleared === 1 ? "" : "s"}.`, "info");
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
