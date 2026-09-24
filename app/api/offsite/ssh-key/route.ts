import { NextResponse } from "next/server";
import { sshPublicKey } from "@/lib/offsite";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";
/** Returns the panel's SSH public key for SFTP destinations, generating one on first use. `{ "regenerate": true }` makes a new one. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { regenerate?: unknown };
    return NextResponse.json({ publicKey: await sshPublicKey(body.regenerate === true) });
  } catch (error) { return apiError(error); }
}
