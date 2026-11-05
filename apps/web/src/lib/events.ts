import "server-only";
import { EventEmitter } from "node:events";
import { sql } from "./db";

// One LISTEN connection per server process, fanned out to every SSE client.
const g = globalThis as unknown as { __runEvents?: EventEmitter; __listening?: Promise<unknown> };

export function runEvents(): EventEmitter {
  if (!g.__runEvents) {
    g.__runEvents = new EventEmitter();
    g.__runEvents.setMaxListeners(0);
  }
  g.__listening ??= sql
    .listen("run_events", (payload) => {
      try {
        const { run_id, id } = JSON.parse(payload) as { run_id: string; id: number };
        g.__runEvents!.emit(run_id, id);
      } catch {
        /* ignore malformed */
      }
    })
    .catch((e) => {
      g.__listening = undefined;
      throw e;
    });
  return g.__runEvents;
}
