import { NextResponse } from "next/server";
import { deleteDetachedWorld, reattachServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";
/** Recreates a container for a world whose container was removed, using its saved server.json. */
export async function POST(_: Request, context: { params: Promise<{ id: string }> }) { try { return NextResponse.json(await reattachServer((await context.params).id), { status: 202 }); } catch (error) { return apiError(error); } }
/** Permanently deletes a detached world directory and its backups. */
export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) { try { await deleteDetachedWorld((await context.params).id); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
