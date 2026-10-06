import { NextResponse } from "next/server";
import { assertManagedServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { clearScheduleFailures, recordEvent } from "@/lib/store";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** Dismisses the scheduled-backup failure warning. It comes back if the next scheduled backup fails too. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { id } = await context.params;
    await assertManagedServer(id);
    const cleared = await clearScheduleFailures(id);
    if (cleared) await recordEvent(id, "backup", `The scheduled backup warning was dismissed after ${cleared} failure${cleared === 1 ? "" : "s"}.`, "info");
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
