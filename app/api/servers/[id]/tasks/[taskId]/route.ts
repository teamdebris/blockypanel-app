import { NextResponse } from "next/server";
import { runTask } from "@/lib/docker";
import { NotFoundError } from "@/lib/errors";
import { assertServerId } from "@/lib/paths";
import { apiError } from "@/lib/responses";
import { deleteTask, getServerControl, saveTask } from "@/lib/store";
import { taskSchema } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; taskId: string }> };

async function findTask(context: Context) {
  const { id, taskId } = await context.params;
  const serverId = assertServerId(id);
  const task = (await getServerControl(serverId)).tasks?.find((item) => item.id === taskId);
  if (!task) throw new NotFoundError("Task not found.");
  return { serverId, task };
}

/** Replaces a task's settings. A changed schedule counts from now, so it doesn't fire for a time already past. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { serverId, task } = await findTask(context);
    const input = taskSchema.parse(await request.json());
    const rescheduled = JSON.stringify(input.schedule) !== JSON.stringify(task.schedule) || (!task.enabled && input.enabled);
    return NextResponse.json(await saveTask(serverId, { ...task, ...input, ...(rescheduled ? { createdAt: new Date().toISOString(), lastRunAt: undefined } : {}) }));
  } catch (error) { return apiError(error); }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const { serverId, task } = await findTask(context);
    await deleteTask(serverId, task.id);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}

/** Runs a task now (a restart skips the warnings). Its schedule isn't affected. */
export async function POST(_: Request, context: Context) {
  try {
    const { serverId, task } = await findTask(context);
    return NextResponse.json(await runTask(serverId, task));
  } catch (error) { return apiError(error); }
}
