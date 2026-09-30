import { NextRequest, NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { BadRequestError, HttpError, NotFoundError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { sftpInfo } from "@/lib/sftp";
import { parsePublicKey, SshKeyError } from "@/lib/ssh-keys";
import { sftpCredentialSchema } from "@/lib/validation";

export const runtime = "nodejs";

async function ownAccount() {
  const viewer = await requireViewer("admin");
  if (!viewer.userId) throw new HttpError(400, "A recovery sign-in has no account to add SFTP keys to. Sign in with your own account.");
  return { viewer, userId: viewer.userId, store: await accounts() };
}

/** Your SFTP keys and passwords, and how to connect. */
export async function GET() {
  try {
    const { viewer, userId, store } = await ownAccount();
    return NextResponse.json({ username: viewer.username, info: await sftpInfo(), credentials: store.listSftpCredentials(userId) });
  } catch (error) { return apiError(error); }
}

/**
 * { action: "key", label, publicKey, password } adds an SSH key; { action: "password", label, password }
 * makes an SFTP password, returned once. Both ask for the account password again: a key outlives
 * the session, so a borrowed browser mustn't be able to add one.
 */
export async function POST(request: Request) {
  try {
    const { viewer, userId, store } = await ownAccount();
    if (process.env.BLOCKY_DEMO === "true") throw new HttpError(400, "SFTP isn't available in the demo.");
    const body = sftpCredentialSchema.parse(await request.json());
    await store.checkPassword(userId, body.password);
    if (body.action === "key") {
      let key;
      try { key = parsePublicKey(body.publicKey); }
      catch (error) { if (error instanceof SshKeyError) throw new BadRequestError(error.message, "publicKey"); throw error; }
      const credential = store.addSftpKey(userId, body.label, key);
      store.audit(viewer.username, `Added an SFTP key "${credential.label}" (${key.fingerprint})`);
      return NextResponse.json({ credential }, { status: 201 });
    }
    const { credential, password } = await store.addSftpPassword(userId, body.label);
    store.audit(viewer.username, `Created an SFTP password "${credential.label}"`);
    return NextResponse.json({ credential, password }, { status: 201 });
  } catch (error) { return apiError(error); }
}

/** ?id=<credential> removes one of your keys or passwords; SFTP sessions using it end within seconds. */
export async function DELETE(request: NextRequest) {
  try {
    const { viewer, userId, store } = await ownAccount();
    const removed = store.deleteSftpCredential(userId, request.nextUrl.searchParams.get("id") || "");
    if (!removed) throw new NotFoundError("That key or password no longer exists.");
    store.audit(viewer.username, `Removed the SFTP ${removed.kind === "key" ? "key" : "password"} "${removed.label}"`);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
