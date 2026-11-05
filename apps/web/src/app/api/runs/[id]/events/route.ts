import { sql } from "@/lib/db";
import { runEvents } from "@/lib/events";
import { UUID, bad } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Server-sent events for one run. Replays everything after `?after=<id>` (or the
 * Last-Event-ID header on reconnect), then streams new rows as Postgres NOTIFYs arrive.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]/events">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const url = new URL(req.url);
  let last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
  const enc = new TextEncoder();
  const bus = runEvents();

  let onNotify: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let busy = false;
      let again = false;
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* closed */
        }
      };
      const flush = async () => {
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            again = false;
            const rows = await sql`SELECT id, step_id, kind, payload, created_at FROM run_events
                                   WHERE run_id=${id} AND id > ${last} ORDER BY id LIMIT 500`;
            for (const r of rows) {
              last = Number(r.id);
              send(`id: ${r.id}\nevent: run\ndata: ${JSON.stringify({ ...r, id: Number(r.id) })}\n\n`);
            }
            if (rows.length === 500) again = true;
          } while (again);
        } finally {
          busy = false;
        }
      };
      onNotify = () => void flush();
      bus.on(id, onNotify);
      ping = setInterval(() => send(": ping\n\n"), 15_000);
      send("retry: 2000\n\n");
      await flush();
    },
    cancel() {
      if (onNotify) bus.off(id, onNotify);
      if (ping) clearInterval(ping);
    },
  });

  req.signal.addEventListener("abort", () => {
    if (onNotify) bus.off(id, onNotify);
    if (ping) clearInterval(ping);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
