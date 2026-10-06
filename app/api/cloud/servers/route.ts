import { NextResponse } from "next/server";
import { setServerPublished } from "@/lib/cloud";
import { apiError } from "@/lib/responses";
import { cloudServerSchema } from "@/lib/validation";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
/** Publishes a server on blockylink.net, or takes it off (a backend behind a proxy, an archived world). */
export async function PATCH(request: Request) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const { serverId, publish } = cloudServerSchema.parse(await request.json());
    return NextResponse.json(await setServerPublished(serverId, publish));
  } catch (error) { return apiError(error); }
}
