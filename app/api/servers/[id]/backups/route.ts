import { NextResponse } from "next/server";
import { deleteBackups, listBackups, restoreBackup } from "@/lib/docker";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { nextScheduledBackupAt } from "@/lib/schedule";
import { getServerControl } from "@/lib/store";
import { backupDeleteSchema, backupRestoreSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const id = assertServerId((await context.params).id);
    const [backups, control] = await Promise.all([listBackups(id), getServerControl(id)]);
    const lastFailure = control.schedule?.consecutiveFailures ? control.events.find((event) => event.type === "backup" && (event.level === "error" || event.level === "warning") && /scheduled backup failed/i.test(event.message)) : undefined;
    return NextResponse.json({
      backups,
      policy: control.backupPolicy,
      schedule: { consecutiveFailures: control.schedule?.consecutiveFailures ?? 0, lastAttemptAt: control.schedule?.lastAttemptAt, lastFailure: lastFailure?.message, nextRunAt: nextScheduledBackupAt(control.backupPolicy, control.schedule) },
    });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const refusal = await guardRoute(request); if (refusal) return refusal; try { const { name } = backupRestoreSchema.parse(await request.json()); return NextResponse.json(await restoreBackup((await context.params).id, name), { status: 202 }); } catch (error) { return apiError(error); } }

/** { names } deletes several local backups at once. Offsite copies aren't affected. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const id = assertServerId((await context.params).id);
    const { names } = backupDeleteSchema.parse(await request.json());
    return NextResponse.json(await deleteBackups(id, names));
  } catch (error) { return apiError(error); }
}
