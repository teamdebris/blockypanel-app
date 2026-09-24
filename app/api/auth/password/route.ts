import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { changePasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Changes your own password and signs out your other sessions. */
export async function PUT(request: Request) {
  try {
    const viewer = await requireViewer();
    if (!viewer.userId) throw new HttpError(400, "A recovery sign-in has no password to change. Reset an account's password from Users instead.");
    if (process.env.BLOCKY_DEMO === "true") throw new HttpError(400, "Passwords can't be changed in the demo.");
    const { current, password } = changePasswordSchema.parse(await request.json());
    const store = await accounts();
    await store.changePassword(viewer.userId, current, password, viewer.sessionId);
    store.audit(viewer.username, "Changed their password");
    return NextResponse.json({ message: "Password changed. Your other devices were signed out." });
  } catch (error) { return apiError(error); }
}
