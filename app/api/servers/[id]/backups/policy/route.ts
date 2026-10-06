import { NextResponse } from "next/server";
import { z } from "zod";
import { assertManagedServer, invalidateServerList } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { getServerControl, setBackupPolicy } from "@/lib/store";
import { backupPolicySchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) { const refusal = await guardRoute(request); if (refusal) return refusal; try { const { id } = await context.params; await assertManagedServer(id); return NextResponse.json(await setBackupPolicy(id, backupPolicySchema.parse(await request.json()))); } catch (error) { return apiError(error); } }

/** { enabled } switches local automatic backups on or off, keeping the interval and retention. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { id } = await context.params;
    await assertManagedServer(id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await request.json());
    const policy = await setBackupPolicy(id, { ...(await getServerControl(id)).backupPolicy, enabled });
    invalidateServerList();
    return NextResponse.json(policy);
  } catch (error) { return apiError(error); }
}
