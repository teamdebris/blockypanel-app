import { NextResponse } from "next/server";
import { rerollWorld } from "@/lib/docker";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { rerollSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Deletes the world and generates a new one. Runs in the background; progress is on the server's operation. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { seed } = rerollSchema.parse(await request.json());
    return NextResponse.json(await rerollWorld(assertServerId((await context.params).id), seed), { status: 202 });
  } catch (error) { return apiError(error); }
}
