// HTTP routes for the Projects page. The caller has already checked the user is signed in.
//   GET    /api/projects          the whole board, its version and recent activity
//   POST   /api/projects/items    {items:[...]} create or change items (same rules as the Bots' tool)
//   POST   /api/projects/delete   {ids:[...]} delete for good
//   GET    /api/projects/events   a live stream (Server-Sent Events) of every change, from anyone

const HEARTBEAT_MS = 25_000;

/** A write must come from this app's own page, never another website using the user's session. */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] ? req.headers["sec-fetch-site"] === "same-origin" : true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  return host === req.headers.host || (forwarded !== "" && host === forwarded);
}

/** `checkOrigin` lets the gateway use its own origin policy when it has one. */
export function createProjectRoutes({ projects, send, readBody, requireJson, heartbeatMs = HEARTBEAT_MS, log = () => {}, checkOrigin = sameOrigin }) {
  const streams = new Set();

  projects.subscribe((event) => {
    const data = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of streams) res.write(data);
  });

  function openStream(req, res) {
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
    const close = () => { clearInterval(beat); streams.delete(res); };
    req.on("close", close);
    res.on("error", close);
    // Tell the page which version it's now following, so it can tell whether it missed anything.
    void projects.snapshot().then((snap) => res.write(`event: hello\ndata: ${JSON.stringify({ version: snap.version })}\n\n`)).catch(() => {});
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/projects" && !p.startsWith("/api/projects/")) return false;
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
      const body = await readBody(req, 4 << 20);
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
        if (error.expose) { send(res, error.status ?? 400, { error: error.message }); return true; }
        throw error;
      }
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  }

  return { handle, streamCount: () => streams.size };
}
