import { cookies } from "next/headers";
import { viewerForToken } from "@/lib/auth";
import { requireViewer } from "@/lib/auth-server";
import { streamLogs } from "@/lib/docker";
import { HttpError } from "@/lib/errors";
import { apiError } from "@/lib/responses";
import { COOKIE_NAME } from "@/lib/session";
import { guardRoute } from "@/lib/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each stream holds a followed Docker log stream open. A few per session covers several tabs;
// more than that is someone (any role can open these) trying to exhaust the panel. Sessions are
// cheap to make, so a user and the whole panel have budgets of their own.
const MAX_STREAMS_PER_SESSION = 6;
const MAX_STREAMS_PER_USER = 12;
const MAX_STREAMS = 200;
// The session is looked up again on every heartbeat, so signing out, a password reset, or
// disabling the account ends an open console within this long.
const HEARTBEAT_MS = 15_000;
// Output a reader isn't taking is held up to this much; the Docker stream is paused meanwhile.
// A reader that stays behind that long, or lets the queue overflow, is disconnected (EventSource reconnects).
const QUEUE_BYTES = 256 * 1024;
const OVERFLOW_BYTES = 1024 * 1024;
const MAX_STALL_MS = 30_000;

const perSession = new Map<string, number>();
const perUser = new Map<string, number>();
let total = 0;

function bump(counts: Map<string, number>, key: string, by: number) {
  const next = (counts.get(key) || 0) + by;
  if (next > 0) counts.set(key, next); else counts.delete(key);
}

/** Server-sent events: each message carries a JSON-encoded chunk of raw console output. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guardRoute(request); if (refusal) return refusal;
  try {
    const viewer = await requireViewer();
    // Kept to look the session up again later, outside this request.
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    const session = viewer.sessionId;
    const user = viewer.userId ?? "recovery";
    if ((perSession.get(session) || 0) >= MAX_STREAMS_PER_SESSION) throw new HttpError(429, "Too many consoles open. Close a few tabs and try again.");
    if ((perUser.get(user) || 0) >= MAX_STREAMS_PER_USER) throw new HttpError(429, "Too many consoles open on this account. Close a few tabs or sign out elsewhere and try again.");
    if (total >= MAX_STREAMS) throw new HttpError(503, "The panel has too many consoles open right now. Try again in a minute.");
    bump(perSession, session, 1);
    bump(perUser, user, 1);
    total += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      bump(perSession, session, -1);
      bump(perUser, user, -1);
      total -= 1;
    };
    let source: Awaited<ReturnType<typeof streamLogs>>;
    try { source = await streamLogs((await context.params).id, request.signal); }
    catch (error) { release(); throw error; }
    const encoder = new TextEncoder();
    let heartbeat: NodeJS.Timeout | undefined;
    let finished = false;
    let stalledSince: number | undefined;
    let finish: (closeBody: boolean) => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Every way out comes through here once: timer, counters, and the Docker stream.
        finish = (closeBody) => {
          if (finished) return;
          finished = true;
          clearInterval(heartbeat);
          release();
          source.destroy();
          if (closeBody) try { controller.close(); } catch { /* already closed */ }
        };
        const send = (text: string) => {
          if (finished) return;
          try { controller.enqueue(encoder.encode(text)); } catch { finish(false); return; }
          const room = controller.desiredSize ?? 0;
          if (room < -OVERFLOW_BYTES) { finish(true); return; }
          if (room <= 0) { source.pause(); stalledSince ??= Date.now(); }
        };
        source.on("data", (chunk: Buffer) => send(`data: ${JSON.stringify(chunk.toString("utf8").replace(/\u0000/g, ""))}\n\n`));
        source.on("end", () => { send("event: end\ndata: \"\"\n\n"); finish(true); });
        source.on("error", () => finish(true));
        source.on("close", () => finish(true));
        heartbeat = setInterval(() => {
          if (stalledSince !== undefined && Date.now() - stalledSince > MAX_STALL_MS) { finish(true); return; }
          void viewerForToken(token).then((current) => { if (current?.sessionId !== session) finish(true); }, () => finish(true));
          // Keeps idle connections from being closed by reverse proxies.
          if ((controller.desiredSize ?? 0) > 0) send(": keep-alive\n\n");
        }, HEARTBEAT_MS);
      },
      pull() {
        // The reader caught up.
        stalledSince = undefined;
        if (!finished && source.isPaused()) source.resume();
      },
      cancel() { finish(false); },
    }, { highWaterMark: QUEUE_BYTES, size: (chunk) => chunk.byteLength });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return apiError(error); }
}
