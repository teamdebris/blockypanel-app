import { NextResponse } from "next/server";
import { discoverOffsite } from "@/lib/offsite";
import { apiError } from "@/lib/responses";
import { offsiteDiscoverSchema } from "@/lib/validation";

export const runtime = "nodejs";
/** Lists the servers stored at a destination, opened with the backup passphrase. */
export async function POST(request: Request) { try { return NextResponse.json(await discoverOffsite(offsiteDiscoverSchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
