// Threebot usage-stats collector: a Cloudflare Worker with one D1 database.
// POST /v1/ping  stores one validated ping per install ID per UTC day (later ones get 429). No IPs,
//                headers or user agents are read or stored.
// GET  /v1/stats dashboard numbers, only with `Authorization: Bearer <STATS_TOKEN>`.
import { MAX_BODY_BYTES, validatePing, type Ping } from "./schema.ts";

// The few D1 calls used here (see @cloudflare/workers-types for the full API).
export interface D1Result<T = Record<string, unknown>> { results: T[]; meta: { changes?: number } }
export interface D1PreparedStatement { bind(...values: unknown[]): D1PreparedStatement; run(): Promise<D1Result>; all<T = Record<string, unknown>>(): Promise<D1Result<T>> }
export interface D1Database { prepare(query: string): D1PreparedStatement; batch(statements: D1PreparedStatement[]): Promise<D1Result[]> }
export interface Env { DB: D1Database; STATS_TOKEN?: string }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Saves a ping; false when this install already sent one today. */
export async function storePing(db: D1Database, ping: Ping, day: string): Promise<boolean> {
  const inserted = await db.prepare(`INSERT OR IGNORE INTO pings (day, install_id, threebot, t3code, node, os, arch, bots, routines, projects, auto_update, fresh_session_routines)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(day, ping.installId, ping.threebot, ping.t3code, ping.node, ping.os, ping.arch, ping.bots, ping.routines,
    Number(ping.features.projects), Number(ping.features.autoUpdate), Number(ping.features.freshSessionRoutines)).run();
  if (!inserted.meta.changes) return false;
  const rows = Object.entries(ping.tokens ?? {}).map(([model, u]) => db.prepare(`INSERT OR IGNORE INTO tokens (day, install_id, model, turns, input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(day, ping.installId, model, u.turns, u.inputTokens, u.cachedInputTokens, u.cacheCreationTokens, u.outputTokens));
  if (rows.length) await db.batch(rows);
  return true;
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new Error("too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error("too large");
  return JSON.parse(text);
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const wanted = new TextEncoder().encode(`Bearer ${token}`);
  let diff = given.length ^ wanted.length;
  for (let i = 0; i < wanted.length; i++) diff |= wanted[i] ^ (given[i] ?? 0);
  return diff === 0;
}

/** Installs by version and tokens by model, per day, for the last `days` days. */
/** Retention: keep 400 days (PRIVACY.md). Runs from the daily Cron Trigger. */
export const RETENTION_DAYS = 400;
export async function prune(db: D1Database, today: string): Promise<void> {
  const cutoff = utcDay(Date.parse(`${today}T00:00:00Z`) - RETENTION_DAYS * 86_400_000);
  await db.batch([db.prepare("DELETE FROM pings WHERE day < ?").bind(cutoff), db.prepare("DELETE FROM tokens WHERE day < ?").bind(cutoff)]);
}

export async function stats(db: D1Database, days: number, today: string) {
  const from = utcDay(Date.parse(today) - (days - 1) * 86400000);
  const [installs, versions, tokens] = await Promise.all([
    db.prepare("SELECT day, COUNT(*) AS installs FROM pings WHERE day >= ? GROUP BY day ORDER BY day").bind(from).all(),
    db.prepare("SELECT day, threebot, COUNT(*) AS installs FROM pings WHERE day >= ? GROUP BY day, threebot ORDER BY day, installs DESC").bind(from).all(),
    db.prepare(`SELECT day, model, SUM(turns) AS turns, SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
      SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS installs
      FROM tokens WHERE day >= ? GROUP BY day, model ORDER BY day, output_tokens DESC`).bind(from).all(),
  ]);
  return { from, to: today, installsByDay: installs.results, installsByVersion: versions.results, tokensByModel: tokens.results };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/ping") {
      if (request.method !== "POST") return json(405, { error: "use POST" });
      let body: unknown;
      try { body = await readBody(request); } catch { return json(400, { error: "invalid body" }); }
      const result = validatePing(body);
      if (!result.ok) return json(400, { error: result.error });
      const stored = await storePing(env.DB, result.ping, utcDay(Date.now()));
      return stored ? new Response(null, { status: 204 }) : json(429, { error: "one ping per install per day" });
    }
    if (url.pathname === "/v1/stats" && request.method === "GET") {
      if (!authorized(request, env.STATS_TOKEN)) return json(404, { error: "not found" });
      const days = Math.min(90, Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
      return json(200, await stats(env.DB, days, utcDay(Date.now())));
    }
    return json(404, { error: "not found" });
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await prune(env.DB, utcDay(Date.now()));
  },
};
