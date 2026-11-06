// HTTP routes for the Projects page. The caller has already checked the user is signed in.
//   GET    /api/projects          the whole board, its version and recent activity
//   POST   /api/projects/items    {items:[...]} create or change items (same rules as the Bots' tool)
//   POST   /api/projects/delete   {ids:[...]} delete for good
//   GET    /api/projects/events   a live stream (Server-Sent Events) of every change, from anyone

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { ProjectStore, ProjectsError } from "./projects.mts";

const HEARTBEAT_MS = 25_000;

/** What the routes read from a request (an http.IncomingMessage, or a test double). */
export type ProjectsRequest = { method?: string; headers: IncomingHttpHeaders; on(event: "close", listener: () => void): unknown };
/** What the live stream writes to (an http.ServerResponse, or a test double). */
export type ProjectsResponse = {
  writeHead(status: number, headers?: OutgoingHttpHeaders): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: "error", listener: () => void): unknown;
};

/** A write must come from this app's own page, never another website using the user's session. */
export function sameOrigin(req: { headers: IncomingHttpHeaders }): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] ? req.headers["sec-fetch-site"] === "same-origin" : true;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  return host === req.headers.host || (forwarded !== "" && host === forwarded);
}

/**
 * `checkOrigin` lets the gateway use its own origin policy when it has one.
 * `enabled` is the Settings → Beta switch: while it's off every /api/projects route answers 404.
 */
export function createProjectRoutes<Req extends ProjectsRequest, Res extends ProjectsResponse>({ projects, send, readBody, requireJson, heartbeatMs = HEARTBEAT_MS, log = () => {}, checkOrigin = sameOrigin, enabled = async () => true }: {
  projects: ProjectStore;
  send: (res: Res, status: number, body: unknown, headers?: Record<string, string>) => void;
  readBody: (req: Req, limit?: number) => Promise<unknown>;
  requireJson: (req: Req) => void;
  heartbeatMs?: number;
  log?: (line: string) => void;
  checkOrigin?: (req: Req) => boolean;
  enabled?: () => Promise<boolean>;
}) {
  const streams = new Set<Res>();
  const closers = new Map<Res, () => void>();

  projects.subscribe((event) => {
    const data = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of streams) res.write(data);
  });

  function openStream(req: Req, res: Res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Proxies must pass each event through as it happens.
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write(`retry: 3000\n\n`);
    streams.add(res);
    const beat = setInterval(() => res.write(`: keep-alive\n\n`), heartbeatMs);
    beat.unref?.();
    const close = () => { clearInterval(beat); streams.delete(res); closers.delete(res); };
    req.on("close", close);
    res.on("error", close);
    closers.set(res, () => { close(); res.end(); });
    // Tell the page which version it's now following, so it can tell whether it missed anything.
    void projects.snapshot().then((snap) => res.write(`event: hello\ndata: ${JSON.stringify({ version: snap.version })}\n\n`)).catch(() => {});
  }

  async function handle(req: Req, res: Res, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p !== "/api/projects" && !p.startsWith("/api/projects/")) return false;
    if (!(await enabled())) { send(res, 404, { error: "not found" }); return true; }
    if (p === "/api/projects" && req.method === "GET") {
      send(res, 200, await projects.snapshot(), { "cache-control": "no-store" });
      return true;
    }
    if (p === "/api/projects/events" && req.method === "GET") {
      openStream(req, res);
      return true;
    }
    if ((p === "/api/projects/items" || p === "/api/projects/delete") && req.method === "POST") {
      if (!checkOrigin(req)) { send(res, 403, { error: "This change didn't come from the app." }); return true; }
      requireJson(req);
      // The page's JSON; save() and remove() check what is in it.
      const body = (await readBody(req, 4 << 20)) as { items?: unknown; ids?: unknown } | null | undefined;
      try {
        if (p === "/api/projects/items") {
          const result = await projects.save(body?.items, { type: "user" });
          send(res, 200, result, { "cache-control": "no-store" });
        } else {
          const result = await projects.remove(body?.ids, { type: "user" });
          log(`projects: deleted ${result.removed.length} item(s) in the app`);
          send(res, 200, result, { "cache-control": "no-store" });
        }
      } catch (error) {
        if ((error as ProjectsError).expose) { send(res, (error as ProjectsError).status ?? 400, { error: (error as ProjectsError).message }); return true; }
        throw error;
      }
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  }

  /** End every open live stream, e.g. when the board is switched off. */
  function closeStreams() {
    for (const close of [...closers.values()]) close();
  }

  return { handle, closeStreams, streamCount: () => streams.size };
}
