import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { assertManagedServer } from "@/lib/docker";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { sftpInfo } from "@/lib/sftp";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

async function context(params: Promise<{ id: string }>) {
  const viewer = await requireViewer("admin");
  if (!viewer.userId) throw new HttpError(400, "A recovery sign-in has no account to sign in to SFTP with. Sign in with your own account.");
  if (process.env.BLOCKY_DEMO === "true") throw new HttpError(400, "SFTP isn't available in the demo.");
  const { id } = await params;
  await assertManagedServer(id);
  const info = await sftpInfo();
  if (!info.enabled) throw new HttpError(409, "SFTP is turned off on this panel (BLOCKY_SFTP=false).");
  return { viewer, userId: viewer.userId, id, info, store: await accounts() };
}

/** How to connect to this server over SFTP, with your password for it (made on first look). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { viewer, userId, id, info, store } = await context(params);
    return NextResponse.json({ ...info, username: `${viewer.username}.${id.slice(0, 8)}`, ...store.serverSftpPassword(userId, id) });
  } catch (error) { return apiError(error); }
}

/** Re-rolls your password for this server. Apps signed in with the old one are disconnected within seconds. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { viewer, userId, id, info, store } = await context(params);
    const password = store.rerollServerSftpPassword(userId, id);
    store.audit(viewer.username, `Re-rolled their SFTP password for server ${id.slice(0, 8)}`);
    return NextResponse.json({ ...info, username: `${viewer.username}.${id.slice(0, 8)}`, ...password });
  } catch (error) { return apiError(error); }
}
