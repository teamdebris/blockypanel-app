import { NextResponse } from "next/server";
import { removeServer, updateServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { updateServerSchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const purge = new URL(request.url).searchParams.get("purge") === "true";
    await removeServer((await context.params).id, { purge });
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await updateServer(id, updateServerSchema.parse(await request.json()));
    return NextResponse.json(result, { status: 202 });
  } catch (error) { return apiError(error); }
}
