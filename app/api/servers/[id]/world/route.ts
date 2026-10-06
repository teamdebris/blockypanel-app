import { NextResponse } from "next/server";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { worldImportSchema } from "@/lib/validation";
import { importWorld } from "@/lib/world-import";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
/** Replaces the world with one from an uploaded archive in the server's files. Runs in the background. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { archive } = worldImportSchema.parse(await request.json());
    return NextResponse.json(await importWorld(assertServerId((await context.params).id), archive), { status: 202 });
  } catch (error) { return apiError(error); }
}
