import { HttpError } from "./errors.ts";

/** Sign-in, invite, and setup requests are a few hundred bytes; anyone can send them, so bigger ones are refused. */
export const PUBLIC_BODY_LIMIT = 16 * 1024;

/**
 * The request's JSON body, read up to `limit` bytes (chunked bodies are counted as they arrive)
 * before anything is parsed. Too large is a 413; not JSON is a SyntaxError, answered as a 400.
 */
export async function readJson(request: Request, limit = PUBLIC_BODY_LIMIT): Promise<unknown> {
  const tooLarge = () => new HttpError(413, "That request is too large.");
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw tooLarge(); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
