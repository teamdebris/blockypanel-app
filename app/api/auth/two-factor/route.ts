import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { otpauthUri } from "@/lib/totp";
import { twoFactorOffSchema, twoFactorSchema } from "@/lib/validation";

export const runtime = "nodejs";

async function ownAccount() {
  const viewer = await requireViewer();
  if (!viewer.userId) throw new HttpError(400, "A recovery sign-in has no account to protect. Sign in with your own account.");
  return { viewer, userId: viewer.userId, store: await accounts() };
}

export async function GET() {
  try {
    const { userId, store } = await ownAccount();
    const enabled = Boolean(store.getUser(userId)?.twoFactor);
    return NextResponse.json({ enabled, recoveryCodesLeft: enabled ? store.recoveryCodesLeft(userId) : 0 });
  } catch (error) { return apiError(error); }
}

/**
 * { action: "start" } returns a new secret and its otpauth link (for the QR code); "confirm" turns
 * two-factor on with a first code and returns recovery codes; "recovery-codes" replaces them.
 */
export async function POST(request: Request) {
  try {
    const { viewer, userId, store } = await ownAccount();
    const body = twoFactorSchema.parse(await request.json());
    if (body.action === "start") {
      if (process.env.BLOCKY_DEMO === "true") throw new HttpError(400, "Two-factor sign-in can't be turned on in the demo.");
      const { secret, username } = store.beginTwoFactor(userId);
      return NextResponse.json({ secret, uri: otpauthUri(secret, username) });
    }
    if (body.action === "confirm") {
      const recoveryCodes = store.confirmTwoFactor(userId, body.code);
      store.audit(viewer.username, "Turned on two-factor sign-in");
      return NextResponse.json({ recoveryCodes });
    }
    await store.checkPassword(userId, body.password);
    const recoveryCodes = store.regenerateRecoveryCodes(userId);
    store.audit(viewer.username, "Made new two-factor recovery codes");
    return NextResponse.json({ recoveryCodes });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    const { viewer, userId, store } = await ownAccount();
    const { password } = twoFactorOffSchema.parse(await request.json());
    await store.checkPassword(userId, password);
    store.disableTwoFactor(userId);
    store.audit(viewer.username, "Turned off two-factor sign-in");
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
