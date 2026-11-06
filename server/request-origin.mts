import type { IncomingHttpHeaders } from "node:http";

// A signed-in browser attaches its Access cookie to requests that other websites start, and
// browsers don't apply the same-origin policy to WebSockets. So being authenticated isn't enough:
// anything that can change state must also have come from this app.
export function allowedOrigins(env = process.env) {
  return new Set(String(env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function sameOriginRequest(req: { headers: IncomingHttpHeaders }, { allowed = new Set(), allowLoopback = false }: { allowed?: Set<string>; allowLoopback?: boolean } = {}): boolean {
  const origin = req.headers.origin;
  // Scripts, curl and the Bots' tools send no Origin. They still need a valid credential.
  if (origin === undefined) return req.headers["sec-fetch-site"] !== "cross-site";
  if (allowed.has(origin)) return true;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (allowLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return parsed.host === req.headers.host;
}
