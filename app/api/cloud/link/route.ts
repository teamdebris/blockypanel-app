import { NextResponse } from "next/server";
import { cancelLink, startLink } from "@/lib/cloud";
import { apiError } from "@/lib/responses";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
/** Gets a code from the console for the owner to approve; the panel then polls until it's approved. */
export async function POST(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { return NextResponse.json(await startLink()); } catch (error) { return apiError(error); } }
export async function DELETE(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; try { cancelLink(); return NextResponse.json({ ok: true }); } catch (error) { return apiError(error); } }
