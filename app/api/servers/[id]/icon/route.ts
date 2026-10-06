import { NextResponse } from "next/server";
import { z } from "zod";
import { managedServerNames } from "@/lib/docker";
import { NotFoundError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { SERVER_ICONS } from "@/lib/server-icons";
import { setServerIcon } from "@/lib/store";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";

const schema = z.object({ icon: z.enum(SERVER_ICONS) });

/** Picks the server's icon. Only the panel's record changes; the server keeps running. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { id } = await context.params;
    const { icon } = schema.parse(await request.json());
    if (!(await managedServerNames()).has(id)) throw new NotFoundError("That server doesn't exist.");
    await setServerIcon(id, icon);
    return NextResponse.json({ icon });
  } catch (error) { return apiError(error); }
}
