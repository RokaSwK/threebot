// Lightweight composable HTTP router for the Bot gateway.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

export type HttpError = Error & { status?: number; code?: string };

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  match: RegExpExecArray | null;
};

export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

export type RouteEntry = {
  method: string | null;
  pattern: string | RegExp;
  handler: RouteHandler;
};

export type SendFn = (res: ServerResponse, status: number, body: unknown, headers?: OutgoingHttpHeaders) => void;

export function createRouter() {
  const routes: RouteEntry[] = [];

  function add(method: string | null, pattern: string | RegExp, handler: RouteHandler) {
    routes.push({ method: method ? method.toUpperCase() : null, pattern, handler });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    for (const entry of routes) {
      if (entry.method && entry.method !== method) continue;
      if (typeof entry.pattern === "string") {
        if (p !== entry.pattern) continue;
        await entry.handler({ req, res, url, path: p, match: null });
        return true;
      }
      const match = entry.pattern.exec(p);
      if (!match) continue;
      await entry.handler({ req, res, url, path: p, match });
      return true;
    }
    return false;
  }

  return {
    get: (pattern: string | RegExp, handler: RouteHandler) => add("GET", pattern, handler),
    post: (pattern: string | RegExp, handler: RouteHandler) => add("POST", pattern, handler),
    put: (pattern: string | RegExp, handler: RouteHandler) => add("PUT", pattern, handler),
    patch: (pattern: string | RegExp, handler: RouteHandler) => add("PATCH", pattern, handler),
    delete: (pattern: string | RegExp, handler: RouteHandler) => add("DELETE", pattern, handler),
    any: (pattern: string | RegExp, handler: RouteHandler) => add(null, pattern, handler),
    handle,
  };
}
