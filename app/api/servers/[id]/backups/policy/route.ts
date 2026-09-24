import { NextResponse } from "next/server";
import { assertManagedServer } from "@/lib/docker";
import { apiError } from "@/lib/responses";
import { setBackupPolicy } from "@/lib/store";
import { backupPolicySchema } from "@/lib/validation";

export const runtime = "nodejs";
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) { try { const { id } = await context.params; await assertManagedServer(id); return NextResponse.json(await setBackupPolicy(id, backupPolicySchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
