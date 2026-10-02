import { NextRequest, NextResponse } from "next/server";
import { BadRequestError } from "@/lib/errors";
import { uploadServerFile } from "@/lib/files";
import { guardApiRequest } from "@/lib/request-guard";
import { apiError } from "@/lib/responses";
import { filePathSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * Uploads a file into the server's folder, streamed straight to disk. This route skips proxy.ts
 * (which would cut the body off at 10 MB), so it runs the API checks itself first. `size` is the
 * file's length in bytes; an upload that arrives shorter or longer is refused and nothing is saved.
 */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardApiRequest(request);
  if (refusal) return refusal;
  try {
    if (!request.body) throw new BadRequestError("Upload body is empty.");
    const query = request.nextUrl.searchParams;
    const requested = filePathSchema.min(1).parse(query.get("path") || "");
    const size = Number(query.get("size"));
    if (!Number.isSafeInteger(size) || size < 0) throw new BadRequestError("The upload is missing its size.");
    await uploadServerFile((await context.params).id, requested, request.body, size);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
