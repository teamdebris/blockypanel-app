import { requireViewer } from "@/lib/auth-server";
import { streamLogs } from "@/lib/docker";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each stream holds a followed Docker log stream open. A few per session covers several tabs;
// more than that is someone (any role can open these) trying to exhaust the panel.
const MAX_STREAMS_PER_SESSION = 6;
const openStreams = new Map<string, number>();

/** Server-sent events: each message carries a JSON-encoded chunk of raw console output. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let session: string | undefined;
  try {
    session = (await requireViewer()).sessionId;
    const open = openStreams.get(session) || 0;
    if (open >= MAX_STREAMS_PER_SESSION) throw new HttpError(429, "Too many consoles open. Close a few tabs and try again.");
    openStreams.set(session, open + 1);
    const key = session;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (openStreams.get(key) || 1) - 1;
      if (remaining > 0) openStreams.set(key, remaining); else openStreams.delete(key);
    };
    let source: Awaited<ReturnType<typeof streamLogs>>;
    try { source = await streamLogs((await context.params).id, request.signal); }
    catch (error) { release(); throw error; }
    const encoder = new TextEncoder();
    let heartbeat: NodeJS.Timeout | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* client gone */ } };
        const close = () => { clearInterval(heartbeat); release(); try { controller.close(); } catch { /* already closed */ } };
        source.on("data", (chunk: Buffer) => send(`data: ${JSON.stringify(chunk.toString("utf8").replace(/\u0000/g, ""))}\n\n`));
        source.on("end", () => { send("event: end\ndata: \"\"\n\n"); close(); });
        source.on("error", close);
        source.on("close", release);
        // Keeps idle connections from being closed by reverse proxies.
        heartbeat = setInterval(() => send(": keep-alive\n\n"), 20_000);
      },
      cancel() { clearInterval(heartbeat); release(); source.destroy(); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return apiError(error); }
}
