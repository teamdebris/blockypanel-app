import { NextResponse } from "next/server";
import { getSystem } from "@/lib/docker";
import { sftpInfo } from "@/lib/sftp";
import { panelVersion } from "@/lib/version";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function GET(request: Request) { const refusal = await guardRoute(request); if (refusal) return refusal; return NextResponse.json({ ...(await getSystem()), panel: panelVersion(), sftp: await sftpInfo().catch(() => ({ enabled: false })) }); }
