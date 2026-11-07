import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validatePing } from "../src/schema.ts";
import worker, { prune, stats, storePing, type D1Database, type D1PreparedStatement, type D1Result } from "../src/worker.ts";

const ID = "3f6c2a51-8d1e-4b7a-9c0f-2e5d7a1b4c93";
const ping = (extra: Record<string, unknown> = {}) => ({
  schema: 1, installId: ID, threebot: "0.1.5", t3code: "0.1.8-nightly.20261106.4275", node: "22.18.0", os: "linux", arch: "x64",
  bots: "2-5", routines: "1", features: { projects: true, autoUpdate: false, freshSessionRoutines: true },
  tokens: { "claude-opus-5-5": { turns: 3, inputTokens: 1200, cachedInputTokens: 900, cacheCreationTokens: 100, outputTokens: 300 } },
  ...extra,
});

/** D1 over node:sqlite, running the real schema.sql. */
function fakeD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const statement = (query: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next) => statement(query, next),
    run: async (): Promise<D1Result> => ({ results: [], meta: { changes: Number(sqlite.prepare(query).run(...(values as never[])).changes) } }),
    all: async <T,>() => ({ results: sqlite.prepare(query).all(...(values as never[])) as T[], meta: {} }),
  });
  return { sqlite, prepare: (query) => statement(query), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("https://collector.example/v1/ping", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("validation keeps only documented fields", () => {
  const result = validatePing({ ...ping(), hostname: "nas.local", email: "a@b.c", features: { ...ping().features, vault: true }, tokens: { m: { ...ping().tokens["claude-opus-5-5"], title: "x" } } });
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.ping).sort(), ["arch", "bots", "features", "installId", "node", "os", "routines", "schema", "t3code", "threebot", "tokens"]);
  assert.deepEqual(Object.keys(result.ping.features).sort(), ["autoUpdate", "freshSessionRoutines", "projects"]);
  assert.deepEqual(Object.keys(result.ping.tokens!.m).sort(), ["cacheCreationTokens", "cachedInputTokens", "inputTokens", "outputTokens", "turns"]);
  // No tokens section (older T3 Code) is fine.
  const { tokens: _, ...noTokens } = ping();
  const older = validatePing({ ...noTokens, t3code: null, routines: null });
  assert.ok(older.ok); assert.equal(older.ping.tokens, null);
});

test("validation refuses anything outside the documented forms", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["schema", { schema: 2 }], ["installId", { installId: "nas-hostname" }], ["installId", { installId: "3f6c2a51-8d1e-1b7a-9c0f-2e5d7a1b4c93" }],
    ["version", { threebot: "my laptop" }], ["t3code", { t3code: 5 }], ["os", { os: "jaimes-mac" }], ["arch", { arch: "" }],
    ["bots", { bots: 3 }], ["bots", { bots: "3" }], ["routines", { routines: "12" }], ["features", { features: { projects: "yes" } }],
    ["model", { tokens: { "/Users/sam/secret": ping().tokens["claude-opus-5-5"] } }], ["model", { tokens: { "has space": ping().tokens["claude-opus-5-5"] } }],
    ["negative", { tokens: { m: { ...ping().tokens["claude-opus-5-5"], outputTokens: -1 } } }], ["fraction", { tokens: { m: { ...ping().tokens["claude-opus-5-5"], turns: 1.5 } } }],
    ["huge", { tokens: { m: { ...ping().tokens["claude-opus-5-5"], inputTokens: 1e15 } } }],
    ["models", { tokens: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`m${i}`, ping().tokens["claude-opus-5-5"]])) }],
  ];
  for (const [label, change] of bad) assert.equal(validatePing(ping(change)).ok, false, label);
  assert.equal(validatePing(null).ok, false); assert.equal(validatePing([]).ok, false);
});

test("the Worker stores one ping per install per day, with no request data", async () => {
  const db = fakeD1();
  const env = { DB: db, STATS_TOKEN: "dashboard-secret" };
  assert.equal((await worker.fetch(post(ping(), { "cf-connecting-ip": "203.0.113.9", "user-agent": "secret-agent" }), env)).status, 204);
  assert.equal((await worker.fetch(post(ping()), env)).status, 429, "second ping the same day");
  assert.equal((await worker.fetch(post({ ...ping(), installId: "not-a-uuid" }), env)).status, 400);
  assert.equal((await worker.fetch(post("{not json"), env)).status, 400);
  assert.equal((await worker.fetch(post("x".repeat(20000)), env)).status, 400, "too large");
  assert.equal((await worker.fetch(new Request("https://collector.example/v1/ping"), env)).status, 405);
  const rows = db.sqlite.prepare("SELECT * FROM pings").all();
  assert.equal(rows.length, 1);
  const stored = JSON.stringify([rows, db.sqlite.prepare("SELECT * FROM tokens").all()]);
  assert.doesNotMatch(stored, /203\.0\.113\.9|secret-agent/);
  assert.deepEqual(db.sqlite.prepare("SELECT model, turns, input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens FROM tokens").all().map((r) => ({ ...r })),
    [{ model: "claude-opus-5-5", turns: 3, input_tokens: 1200, cached_input_tokens: 900, cache_creation_tokens: 100, output_tokens: 300 }]);
});

test("stats need the token and sum installs and tokens per day", async () => {
  const db = fakeD1();
  const env = { DB: db, STATS_TOKEN: "dashboard-secret" };
  await worker.fetch(post(ping()), env);
  await worker.fetch(post(ping({ installId: "0b8e4f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b", threebot: "0.1.4" })), env);
  assert.equal((await worker.fetch(new Request("https://collector.example/v1/stats"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://collector.example/v1/stats", { headers: { authorization: "Bearer wrong" } }), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://collector.example/v1/stats"), { DB: db })).status, 404, "no token configured");
  const response = await worker.fetch(new Request("https://collector.example/v1/stats?days=7", { headers: { authorization: "Bearer dashboard-secret" } }), env);
  assert.equal(response.status, 200);
  const body = await response.json() as Awaited<ReturnType<typeof stats>>;
  assert.equal((body.installsByDay[0] as { installs: number }).installs, 2);
  assert.deepEqual(body.installsByVersion.map((r) => (r as { threebot: string }).threebot).sort(), ["0.1.4", "0.1.5"]);
  assert.deepEqual(body.tokensByModel.map((r) => ({ ...r as object, day: undefined })), [{ day: undefined, model: "claude-opus-5-5", turns: 6, input_tokens: 2400, cached_input_tokens: 1800, cache_creation_tokens: 200, output_tokens: 600, installs: 2 }]);
});

test("dashboard queries run against the schema", () => {
  const db = fakeD1();
  const queries = readFileSync(new URL("../queries.sql", import.meta.url), "utf8").split(";").map((q) => q.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  assert.ok(queries.length >= 8);
  for (const query of queries) db.sqlite.prepare(query).all();
});

test("the daily prune drops rows older than 400 days and keeps the rest", async () => {
  const db = fakeD1();
  const old = validatePing(ping()); assert.ok(old.ok);
  await storePing(db, old.ping, "2025-10-01");
  await storePing(db, old.ping, "2026-11-07");
  await prune(db, "2026-11-07");
  const days = (table: string) => (db.sqlite.prepare(`SELECT day FROM ${table} ORDER BY day`).all() as { day: string }[]).map((r) => r.day);
  assert.deepEqual(days("pings"), ["2026-11-07"]);
  assert.deepEqual(days("tokens"), ["2026-11-07"]);
});
