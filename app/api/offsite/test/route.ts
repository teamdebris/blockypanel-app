import { NextResponse } from "next/server";
import { testDestination } from "@/lib/offsite";
import { apiError } from "@/lib/responses";
import { offsiteTestSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function POST(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await testDestination(offsiteTestSchema.parse(await request.json()).destination)); } catch (error) { return apiError(error); } }
