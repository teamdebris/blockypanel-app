import { NextResponse } from "next/server";
import { getSystem } from "@/lib/docker";
import { sftpInfo } from "@/lib/sftp";
import { panelVersion } from "@/lib/version";

export const runtime = "nodejs";
export async function GET() { return NextResponse.json({ ...(await getSystem()), panel: panelVersion(), sftp: await sftpInfo().catch(() => ({ enabled: false })) }); }
