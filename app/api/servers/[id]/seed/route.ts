import { NextResponse } from "next/server";
import { worldSeed } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** The world's seed as a number, for the seed map link. A random seed is asked of the running game once. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    return NextResponse.json(await worldSeed((await context.params).id));
  } catch (error) { return apiError(error); }
}
