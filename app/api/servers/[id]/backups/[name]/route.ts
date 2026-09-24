import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { assertManagedServer, deleteBackup } from "@/lib/docker";
import { getIncrementalSnapshot, openIncrementalDownload } from "@/lib/incremental-backups";
import { apiError } from "@/lib/responses";
import { backupNameSchema } from "@/lib/validation";

export const runtime = "nodejs";

function attachment(filename: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string; name: string }> }) {
  try {
    const { id, name: rawName } = await context.params;
    const name = backupNameSchema.parse(rawName);
    await assertManagedServer(id);
    // Resolve the snapshot before streaming so a bad name returns an error instead of a broken download.
    const snapshot = await getIncrementalSnapshot(id, name);
    const stream = openIncrementalDownload(id, snapshot, request.signal);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, { headers: { "Content-Type": "application/x-tar", "Content-Disposition": attachment(`${name}.tar`) } });
  } catch (error) { return apiError(error); }
}
export async function DELETE(_: Request, context: { params: Promise<{ id: string; name: string }> }) { try { const { id, name } = await context.params; await assertManagedServer(id); await deleteBackup(id, backupNameSchema.parse(name)); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
