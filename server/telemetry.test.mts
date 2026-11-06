import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { aggregateTurnUsage, bucket, buildPayload, createTelemetry, envOptOut, SEND_INTERVAL_MS, versionAtLeast, type PayloadInput } from "./telemetry.mts";
import { validatePing } from "../telemetry/src/schema.ts";

const DAY = SEND_INTERVAL_MS;
const input = (extra: Partial<PayloadInput> = {}): PayloadInput => ({
  installId: "3f6c2a51-8d1e-4b7a-9c0f-2e5d7a1b4c93", threebot: "0.1.5", t3code: "0.1.7", node: "22.18.0", os: "linux", arch: "arm64",
  bots: 3, routines: 0, features: { projects: true, autoUpdate: true, freshSessionRoutines: false },
  tokens: { "claude-opus-5-5": { turns: 1, inputTokens: 10, cachedInputTokens: 5, cacheCreationTokens: 1, outputTokens: 2 } }, ...extra,
});

async function harness({ env = {}, endpoint = "https://collector.example/v1/ping", status = 204, saved }: { env?: Record<string, string>; endpoint?: string; status?: number; saved?: object } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "telemetry-test-"));
  const file = path.join(dir, "telemetry.json");
  if (saved) await writeFile(file, JSON.stringify(saved));
  let clock = Date.parse("2026-11-06T10:00:00Z");
  const sent: { url: string; body: any }[] = [];
  const windows: { since: number; until: number }[] = [];
  const telemetry = createTelemetry({
    file, env, endpoint, now: () => clock,
    collect: async (window) => { windows.push(window); return input({ installId: (await telemetry.status()).installId }); },
    fetch: (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status }); }) as typeof fetch,
  });
  return { telemetry, sent, windows, file, advance: (ms: number) => { clock += ms; }, now: () => clock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("stats are off and unasked by default, and nothing is sent", async () => {
  const h = await harness();
  try {
    const status = await h.telemetry.status();
    assert.equal(status.enabled, false); assert.equal(status.asked, false); assert.equal(status.choice, null); assert.equal(status.blockedBy, null);
    assert.match(status.installId, /^[0-9a-f-]{36}$/);
    await h.telemetry.tick(); h.advance(3 * DAY); await h.telemetry.tick();
    assert.equal(h.sent.length, 0);
    // An existing install updating (a telemetry.json without a choice, or none at all) is asked, not assumed.
    await h.telemetry.setEnabled(false);
    assert.deepEqual([(await h.telemetry.status()).asked, (await h.telemetry.status()).enabled], [true, false]);
    await h.telemetry.tick();
    assert.equal(h.sent.length, 0);
  } finally { await h.cleanup(); }
});

test("DO_NOT_TRACK and THREEBOT_TELEMETRY=0 force stats off even when turned on", async () => {
  assert.equal(envOptOut({}), null);
  assert.equal(envOptOut({ DO_NOT_TRACK: "1" }), "DO_NOT_TRACK");
  assert.equal(envOptOut({ DO_NOT_TRACK: "true" }), "DO_NOT_TRACK");
  assert.equal(envOptOut({ DO_NOT_TRACK: "0" }), null);
  assert.equal(envOptOut({ DO_NOT_TRACK: "" }), null);
  assert.equal(envOptOut({ THREEBOT_TELEMETRY: "0" }), "THREEBOT_TELEMETRY");
  assert.equal(envOptOut({ THREEBOT_TELEMETRY: "off" }), "THREEBOT_TELEMETRY");
  assert.equal(envOptOut({ THREEBOT_TELEMETRY: "1" }), null);
  for (const env of [{ DO_NOT_TRACK: "1" }, { THREEBOT_TELEMETRY: "0" }] as Record<string, string>[]) {
    const h = await harness({ env, saved: { installId: "3f6c2a51-8d1e-4b7a-9c0f-2e5d7a1b4c93", enabled: true } });
    try {
      assert.equal((await h.telemetry.status()).enabled, false);
      assert.equal((await h.telemetry.status()).blockedBy, Object.keys(env)[0]);
      await h.telemetry.tick();
      assert.equal(h.sent.length, 0);
    } finally { await h.cleanup(); }
  }
});

test("turned on, it sends at most one ping a day and none without an endpoint", async () => {
  const none = await harness({ endpoint: "" });
  try { await none.telemetry.setEnabled(true); await none.telemetry.tick(); assert.equal(none.sent.length, 0); assert.equal((await none.telemetry.status()).endpoint, false); }
  finally { await none.cleanup(); }
  const h = await harness();
  try {
    await h.telemetry.setEnabled(true);
    const enabledAt = h.now();
    await h.telemetry.tick();
    assert.equal(h.sent.length, 1);
    assert.equal(h.windows[0].since, enabledAt, "the first ping counts tokens from when stats were turned on");
    assert.ok(validatePing(h.sent[0].body).ok, "the collector accepts the ping");
    h.advance(DAY - 60_000); await h.telemetry.tick();
    assert.equal(h.sent.length, 1, "not again within a day");
    h.advance(60_000); await h.telemetry.tick();
    assert.equal(h.sent.length, 2);
    assert.equal(h.windows.at(-1)!.since, h.now() - DAY, "the next window starts where the last ping ended");
    assert.ok((await h.telemetry.status()).lastSentAt);
  } finally { await h.cleanup(); }
});

test("a failing collector is retried a day later, not sooner, and its tokens carry over", async () => {
  const h = await harness({ status: 500 });
  try {
    await h.telemetry.setEnabled(true);
    const enabledAt = h.now();
    await h.telemetry.tick(); h.advance(60 * 60 * 1000); await h.telemetry.tick(); await h.telemetry.tick();
    assert.equal(h.sent.length, 1);
    const status = await h.telemetry.status();
    assert.equal(status.lastSentAt, null); assert.match(status.lastError!, /500/);
    h.advance(DAY); await h.telemetry.tick();
    assert.equal(h.sent.length, 2);
    assert.equal(h.windows.at(-1)!.since, enabledAt);
    // Long outages look back a week at most.
    h.advance(30 * DAY); await h.telemetry.tick();
    assert.equal(h.windows.at(-1)!.since, h.now() - 7 * DAY);
  } finally { await h.cleanup(); }
});

test("a collector that hangs or throws never throws out of tick", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "telemetry-test-"));
  try {
    const telemetry = createTelemetry({ file: path.join(dir, "t.json"), env: {}, endpoint: "https://x.example", collect: async () => { throw new Error("T3 is down"); }, fetch: (async () => new Response()) as typeof fetch });
    await telemetry.setEnabled(true);
    await telemetry.tick();
    assert.match((await telemetry.status()).lastError!, /T3 is down/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the install ID is random, saved, resettable and never sent while off", async () => {
  const h = await harness();
  try {
    const first = (await h.telemetry.status()).installId;
    await h.telemetry.setEnabled(false);
    assert.equal(JSON.parse(await readFile(h.file, "utf8")).installId, first);
    const reset = (await h.telemetry.resetId()).installId;
    assert.notEqual(reset, first);
    assert.match(reset, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal((await h.telemetry.preview()).installId, reset);
    await assert.rejects(h.telemetry.setEnabled("yes"), /true or false/);
  } finally { await h.cleanup(); }
});

test("buckets", () => {
  assert.deepEqual([0, 1, 2, 5, 6, 10, 11, 400, -1, NaN].map(bucket), ["0", "1", "2-5", "2-5", "6-10", "6-10", "11+", "11+", "0", "0"]);
});

test("the payload has only the documented fields, bucketed and cleaned", () => {
  const payload = buildPayload({ ...input({ bots: 7, routines: 12, t3code: "jaime's nas", os: "sunos", arch: "mips" }),
    // Extra fields a caller might pass by mistake never reach the ping.
    ...({ hostname: "nas.local", email: "sam@example.com", botNames: ["Alpha"], cwd: "/Users/sam" } as object) });
  assert.deepEqual(Object.keys(payload).sort(), ["arch", "bots", "features", "installId", "node", "os", "routines", "schema", "t3code", "threebot", "tokens"]);
  assert.equal(payload.bots, "6-10"); assert.equal(payload.routines, "11+");
  assert.equal(payload.t3code, "other"); assert.equal(payload.os, "other"); assert.equal(payload.arch, "other");
  assert.doesNotMatch(JSON.stringify(payload), /nas|sam|Alpha|Users/);
  const older = buildPayload(input({ tokens: null, t3code: null, routines: null }));
  assert.equal("tokens" in older, false); assert.equal(older.t3code, null); assert.equal(older.routines, null);
  assert.ok(validatePing(older).ok);
});

test("versionAtLeast reads release and nightly versions", () => {
  assert.equal(versionAtLeast("0.1.5", "0.1.5"), true);
  assert.equal(versionAtLeast("0.1.8-nightly.20261106.4275", "0.1.5"), true);
  assert.equal(versionAtLeast("0.1.4", "0.1.5"), false);
  assert.equal(versionAtLeast("0.2.0", "0.1.5"), true);
  assert.equal(versionAtLeast(null, "0.1.5"), false);
  assert.equal(versionAtLeast("fixture", "0.1.5"), false);
});

// Thread projections in T3 Code's own shape (orchestration.getThreadProjection, 0.1.7+ and 0.1.5–0.1.6).
const at = (iso: string) => Date.parse(iso);
const projection = {
  runs: [{ id: "run-1", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } }, { id: "run-2", modelSelection: { instanceId: "codex", model: "gpt-6" } }],
  attempts: [{ id: "attempt-1", runId: "run-1" }, { id: "attempt-2", runId: "run-2" }],
  providerTurns: [
    // 0.1.7+: the model T3 reported wins over the run's selection.
    { runAttemptId: "attempt-1", completedAt: "2026-11-06T09:00:00.000Z", turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1000, outputTokens: 200, cachedInputTokens: 700, cacheCreationTokens: 50, hasSubagents: false, models: ["claude-opus-5-5-20261001"] } },
    // 0.1.5–0.1.6: no models; the run's selected model is used.
    { runAttemptId: "attempt-2", completedAt: "2026-11-06T09:30:00.000Z", turnTokenUsage: { usageScope: "main_agent", usageStatus: "partial", inputTokens: 300, hasSubagents: false } },
    { runAttemptId: "attempt-1", completedAt: "2026-11-06T09:40:00.000Z", turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1, outputTokens: 1, hasSubagents: false, models: ["a", "b"] } },
    // Left out: before the window, still running, unavailable, a local command, and a turn with no usage.
    { runAttemptId: "attempt-1", completedAt: "2026-11-01T00:00:00.000Z", turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 9999, outputTokens: 9999, hasSubagents: false } },
    { runAttemptId: "attempt-1", completedAt: null, turnTokenUsage: { usageScope: "main_agent", usageStatus: "partial", inputTokens: 9999, hasSubagents: false } },
    { runAttemptId: "attempt-1", completedAt: "2026-11-06T09:50:00.000Z", turnTokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false } },
    { runAttemptId: "attempt-1", completedAt: "2026-11-06T09:55:00.000Z", turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 9999, outputTokens: 0, hasSubagents: false, localCommand: true } },
    { runAttemptId: "attempt-1", completedAt: "2026-11-06T09:56:00.000Z" },
  ],
};

test("token aggregation sums provider turns per model inside the window", () => {
  const window = { since: at("2026-11-05T10:00:00Z"), until: at("2026-11-06T10:00:00Z") };
  const result = aggregateTurnUsage([projection, { ...projection, providerTurns: [projection.providerTurns[0]] }], window);
  assert.equal(result.seen, true);
  assert.deepEqual(result.models, {
    "claude-opus-5-5-20261001": { turns: 2, inputTokens: 2000, cachedInputTokens: 1400, cacheCreationTokens: 100, outputTokens: 400 },
    "gpt-6": { turns: 1, inputTokens: 300, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
    multiple: { turns: 1, inputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1 },
  });
});

test("older T3 Code without turn usage gives no token section", () => {
  const window = { since: 0, until: Date.now() };
  // Before 0.1.5: projections have no providerTurns, or turns without turnTokenUsage.
  const result = aggregateTurnUsage([{ runs: [] }, { providerTurns: [{ runAttemptId: "a", completedAt: "2026-11-06T09:00:00Z" }] }, null], window);
  assert.deepEqual(result, { seen: false, models: {} });
});

test("model ids that aren't ids are not sent, and the model list is capped", () => {
  const turn = (model: string) => ({ completedAt: "2026-11-06T09:00:00Z", turnTokenUsage: { usageStatus: "complete", inputTokens: 1, outputTokens: 1, models: [model] } });
  const window = { since: 0, until: at("2026-11-07T00:00:00Z") };
  assert.deepEqual(Object.keys(aggregateTurnUsage([{ providerTurns: [turn("/Users/sam/models/private one")] }], window).models), ["unknown"]);
  const many = aggregateTurnUsage([{ providerTurns: Array.from({ length: 40 }, (_, i) => turn(`model-${i}`)) }], window).models;
  assert.equal(Object.keys(many).length, 31);
  assert.equal(many.other.turns, 10);
});

test("turning stats off while a ping is being gathered or sent stops it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "telemetry-test-"));
  try {
    let sent = 0;
    const telemetry = createTelemetry({ file: path.join(dir, "t.json"), env: {}, endpoint: "https://x.example",
      collect: async () => { await telemetry.setEnabled(false); return input(); },
      fetch: (async () => { sent++; return new Response(null, { status: 204 }); }) as typeof fetch });
    await telemetry.setEnabled(true);
    await telemetry.tick();
    assert.equal(sent, 0, "off during collection");
    // Off while the request is in flight: the request is aborted.
    let signal: AbortSignal | undefined;
    const slow = createTelemetry({ file: path.join(dir, "s.json"), env: {}, endpoint: "https://x.example", collect: async () => input(),
      fetch: ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => { signal = init.signal!; signal.addEventListener("abort", () => reject(signal!.reason)); })) as typeof fetch });
    await slow.setEnabled(true);
    const ticking = slow.tick();
    while (!signal) await new Promise((resolve) => setTimeout(resolve, 1));
    await slow.setEnabled(false);
    await ticking;
    assert.equal(signal.aborted, true);
    assert.equal((await slow.status()).lastSentAt, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("turning stats off and on again doesn't allow a second ping the same day", async () => {
  const h = await harness();
  try {
    await h.telemetry.setEnabled(true);
    await h.telemetry.tick();
    h.advance(60_000);
    await h.telemetry.setEnabled(false);
    await h.telemetry.setEnabled(true);
    await h.telemetry.tick();
    assert.equal(h.sent.length, 1);
    h.advance(DAY); await h.telemetry.tick();
    assert.equal(h.sent.length, 2);
    assert.equal(h.windows.at(-1)!.since, h.now() - DAY, "tokens from when stats were turned back on");
  } finally { await h.cleanup(); }
});
