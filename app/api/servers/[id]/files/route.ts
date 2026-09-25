import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { createServerDirectory, deleteServerFile, extractServerArchive, listServerFiles, readServerTextFile, renameServerFile, serverFileForDownload, uploadServerFile, writeServerTextFile } from "@/lib/files";
import { BadRequestError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { fileDirectorySchema, filePathSchema, fileRenameSchema, fileWriteSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    const requested = filePathSchema.parse(query.get("path") || "");
    const mode = query.get("mode") || "list";
    if (mode === "content") return NextResponse.json({ path: requested, content: await readServerTextFile(id, requested) });
    if (mode === "download") {
      const result = await serverFileForDownload(id, requested);
      const encoded = encodeURIComponent(result.name);
      return new NextResponse(Readable.toWeb(result.handle.createReadStream()) as ReadableStream, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(result.size), "Content-Disposition": `attachment; filename*=UTF-8''${encoded}` } });
    }
    return NextResponse.json({ path: requested, entries: await listServerFiles(id, requested) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json();
    const { id } = await context.params;
    // { from, to } renames an entry; { extract } unpacks an archive where it is; { path } creates a directory.
    if (body && typeof body === "object" && "extract" in body) {
      const result = await extractServerArchive(id, filePathSchema.min(1).parse((body as { extract: unknown }).extract));
      return NextResponse.json(result);
    }
    if (body && typeof body === "object" && "from" in body) {
      const { from, to } = fileRenameSchema.parse(body);
      await renameServerFile(id, from, to);
    } else {
      await createServerDirectory(id, fileDirectorySchema.parse(body).path);
    }
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { path, content } = fileWriteSchema.parse(await request.json());
    await writeServerTextFile((await context.params).id, path, content);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!request.body) throw new BadRequestError("Upload body is empty.");
    const requested = filePathSchema.min(1).parse(new URL(request.url).searchParams.get("path") || "");
    await uploadServerFile((await context.params).id, requested, request.body);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const requested = filePathSchema.min(1).parse(new URL(request.url).searchParams.get("path") || "");
    await deleteServerFile((await context.params).id, requested);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
