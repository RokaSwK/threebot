// Unified SSE stream for gateway state changes (bots, rooms, machines).
import type { IncomingMessage, ServerResponse } from "node:http";

export type GatewayEventName = "bots" | "rooms" | "machines";

export function createEventStream({ heartbeatMs = 25_000 }: { heartbeatMs?: number } = {}) {
  const streams = new Set<ServerResponse>();
  const closers = new Map<ServerResponse, () => void>();

  function handle(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write("retry: 3000\n\n");
    streams.add(res);
    const beat = setInterval(() => {
      try { res.write(": keep-alive\n\n"); } catch { /* stream closing */ }
    }, heartbeatMs);
    beat.unref?.();
    const close = () => {
      clearInterval(beat);
      streams.delete(res);
      closers.delete(res);
    };
    req.on("close", close);
    res.on("error", close);
    closers.set(res, () => {
      close();
      try { res.end(); } catch { /* already ended */ }
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  }

  function emit(event: GatewayEventName, data: unknown = {}) {
    if (!streams.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) {
      try { res.write(payload); } catch { /* stream closing */ }
    }
  }

  function closeAll() {
    for (const close of [...closers.values()]) close();
  }

  return {
    handle,
    emit,
    closeAll,
    clientCount: () => streams.size,
  };
}

export type EventStream = ReturnType<typeof createEventStream>;
