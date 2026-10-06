import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { removeServer, updateServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { updateServerSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const purge = new URL(request.url).searchParams.get("purge") === "true";
    const { id } = await context.params;
    await removeServer(id, { purge });
    (await accounts()).deleteServerSftpPasswords(id);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { id } = await context.params;
    const result = await updateServer(id, updateServerSchema.parse(await request.json()));
    return NextResponse.json(result, { status: 202 });
  } catch (error) { return apiError(error); }
}
