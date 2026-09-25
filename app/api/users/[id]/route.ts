import { NextResponse } from "next/server";
import { accounts } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { NotFoundError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { ROLE_LABELS } from "@/lib/roles";
import { userActionSchema, userUpdateSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

async function target(context: Context) {
  const store = await accounts();
  const user = store.getUser((await context.params).id);
  if (!user) throw new NotFoundError("User not found.");
  return { store, user };
}

/** Changes a role or disables/enables an account. Either signs that user out. */
export async function PATCH(request: Request, context: Context) {
  try {
    const viewer = await requireViewer("admin");
    const { role, disabled } = userUpdateSchema.parse(await request.json());
    const { store, user } = await target(context);
    if (role && role !== user.role) {
      store.setRole(viewer.userId, user.id, role);
      store.audit(viewer.username, `Changed ${user.username} from ${ROLE_LABELS[user.role]} to ${ROLE_LABELS[role]}`);
    }
    if (disabled !== undefined && disabled !== user.disabled) {
      store.setDisabled(viewer.userId, user.id, disabled);
      store.audit(viewer.username, `${disabled ? "Disabled" : "Enabled"} ${user.username}`);
    }
    return NextResponse.json({ user: store.getUser(user.id) });
  } catch (error) { return apiError(error); }
}

/**
 * { action: "reset-link" } makes a one-time password-reset link; "sign-out" ends all their sessions;
 * "disable-two-factor" turns off their two-factor sign-in (for a lost phone).
 */
export async function POST(request: Request, context: Context) {
  try {
    const viewer = await requireViewer("admin");
    const { action } = userActionSchema.parse(await request.json());
    const { store, user } = await target(context);
    if (action === "disable-two-factor") {
      store.disableTwoFactor(user.id);
      store.audit(viewer.username, `Turned off two-factor sign-in for ${user.username}`);
      return NextResponse.json({ ok: true });
    }
    if (action === "sign-out") {
      store.deleteUserSessions(user.id, user.id === viewer.userId ? viewer.sessionId : undefined);
      store.audit(viewer.username, `Signed ${user.username} out everywhere`);
      return NextResponse.json({ ok: true });
    }
    const { token, invite } = store.createResetLink(user.id, viewer.username);
    store.audit(viewer.username, `Created a password-reset link for ${user.username}`);
    return NextResponse.json({ token, invite }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const viewer = await requireViewer("admin");
    const { store, user } = await target(context);
    store.deleteUser(viewer.userId, user.id);
    store.audit(viewer.username, `Deleted ${user.username}`);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
