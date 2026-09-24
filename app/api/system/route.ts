import { NextResponse } from "next/server";
import { getSystem } from "@/lib/docker";

export const runtime = "nodejs";
export async function GET() { return NextResponse.json(await getSystem()); }
