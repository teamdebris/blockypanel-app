import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { assertManagedServer } from "@/lib/docker";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { getServerControl, saveTask } from "@/lib/store";
import { nextRun, type ScheduledTask } from "@/lib/tasks";
import { taskSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Tasks with when each runs next, for the Schedule tab. */
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = assertServerId((await context.params).id);
    const tasks = (await getServerControl(id)).tasks ?? [];
    return NextResponse.json({ tasks: tasks.map((task) => ({ ...task, nextRunAt: task.enabled ? new Date(nextRun(task)).toISOString() : undefined })) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = assertServerId((await context.params).id);
    await assertManagedServer(id);
    const input = taskSchema.parse(await request.json());
    const task: ScheduledTask = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    return NextResponse.json(await saveTask(id, task), { status: 201 });
  } catch (error) { return apiError(error); }
}
