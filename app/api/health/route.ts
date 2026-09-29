import { NextResponse } from "next/server";
import { getSystem } from "@/lib/docker";

export const runtime = "nodejs";

// Anyone can call this (Compose's health check does), and each check asks Docker for its version
// and container list, so one answer serves every probe within a few seconds.
const CACHE_MS = 5000;
let cached: { at: number; value: Promise<Awaited<ReturnType<typeof getSystem>>> } | undefined;

export async function GET() {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const value = getSystem();
    cached = { at: Date.now(), value };
    value.catch(() => { if (cached?.value === value) cached = undefined; });
  }
  const system = await cached.value;
  return NextResponse.json({ ok: true, dockerAvailable: system.dockerAvailable }, { status: system.dockerAvailable ? 200 : 503 });
}
