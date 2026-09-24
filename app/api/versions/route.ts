import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Manifest = { latest?: { release?: string }; versions?: { id: string; type: string }[] };
let cache: { at: number; versions: string[] } | undefined;

/** Recent Minecraft releases for the version picker. Falls back to an empty list when offline. */
export async function GET() {
  if (!cache || Date.now() - cache.at > 6 * 60 * 60 * 1000) {
    try {
      const response = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", { signal: AbortSignal.timeout(5000) });
      const manifest = await response.json() as Manifest;
      const versions = (manifest.versions || []).filter((version) => version.type === "release").map((version) => version.id).slice(0, 40);
      cache = { at: Date.now(), versions };
    } catch {
      return NextResponse.json({ versions: cache?.versions || [] });
    }
  }
  return NextResponse.json({ versions: cache.versions });
}
