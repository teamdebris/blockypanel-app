import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer, withPasswordCheck } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { changePasswordSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

/** Changes your own password, signs out your other sessions, and replaces your SFTP passwords. */
export async function PUT(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const viewer = await requireViewer();
    if (!viewer.userId) throw new HttpError(400, "A recovery sign-in has no password to change. Reset an account's password from Users instead.");
    if (process.env.BLOCKY_DEMO === "true") throw new HttpError(400, "Passwords can't be changed in the demo.");
    const { current, password } = changePasswordSchema.parse(await request.json());
    const store = await accounts();
    const userId = viewer.userId;
    const refused = await withPasswordCheck(userId, () => store.changePassword(userId, current, password, viewer.sessionId));
    if (refused) return refused;
    store.audit(viewer.username, "Changed their password");
    return NextResponse.json({ message: "Password changed. Your other devices were signed out, and your SFTP passwords were replaced." });
  } catch (error) { return apiError(error); }
}
