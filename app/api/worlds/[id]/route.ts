import { NextResponse } from "next/server";
import { deleteDetachedWorld, reattachServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
/** Recreates a container for a world whose container was removed, using its saved server.json. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await reattachServer((await context.params).id), { status: 202 }); } catch (error) { return apiError(error); } }
/** Permanently deletes a detached world directory and its backups. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { const refusal = await guardRoute(request); if (refusal) return refusal; try { await deleteDetachedWorld((await context.params).id); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
