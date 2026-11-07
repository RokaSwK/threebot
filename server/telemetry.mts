// Anonymous usage stats: off until the user turns them on. At most one small ping a day, sent by the
// gateway (never the browser), so Roka can see how many installs are active, which versions they run
// and how many tokens their Bots use per model. PRIVACY.md lists every field; Settings → Usage stats
// shows the exact next ping. Nothing here may block startup or a request: every failure is silent.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Bump when the payload's shape changes; the collector refuses schemas it doesn't know. */
export const TELEMETRY_SCHEMA = 1;
/**
 * Where pings go: the collector in telemetry/, deployed at stats.swk.tools. Nothing is sent unless the user
 * has turned stats on. THREEBOT_TELEMETRY_URL overrides it (for testing a collector).
 */
export const TELEMETRY_ENDPOINT = "https://stats.swk.tools/v1/ping";
export const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A failed or quiet day doesn't make the next ping cover months: token counts look back a week at most. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SEND_TIMEOUT_MS = 5000;
/** T3 Code reports per-turn token usage on thread projections from this version (`providerTurns[].turnTokenUsage`). */
export const MIN_T3_FOR_TOKENS = "0.1.5";
const MAX_MODELS = 30;

export type Bucket = "0" | "1" | "2-5" | "6-10" | "11+";
export type UsageTotals = { turns: number; inputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number };
export type TelemetryPayload = {
  schema: typeof TELEMETRY_SCHEMA;
  installId: string;
  threebot: string;
  t3code: string | null;
  node: string;
  os: string;
  arch: string;
  bots: Bucket;
  routines: Bucket | null;
  features: { projects: boolean; autoUpdate: boolean; freshSessionRoutines: boolean };
  /** Only when T3 Code reports token usage; absent on older T3 Code. */
  tokens?: Record<string, UsageTotals>;
};
/** What the gateway gathers for a ping. */
export type PayloadInput = {
  installId: string; threebot: string; t3code: string | null; node: string; os: string; arch: string;
  bots: number; routines: number | null; features: TelemetryPayload["features"]; tokens: Record<string, UsageTotals> | null;
};
/** telemetry.json. `enabled` is null until the user has answered the one-time question. */
export type TelemetryState = {
  installId: string;
  enabled: boolean | null;
  decidedAt: string | null;
  enabledAt: string | null;
  lastSentAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

/** DO_NOT_TRACK=1 or THREEBOT_TELEMETRY=0 turn stats off whatever the setting says. Returns which one. */
export function envOptOut(env: Record<string, string | undefined> = process.env): "DO_NOT_TRACK" | "THREEBOT_TELEMETRY" | null {
  const off = (value: string | undefined) => value !== undefined && /^(0|false|off|no)$/i.test(value.trim());
  const on = (value: string | undefined) => value !== undefined && value.trim() !== "" && !off(value);
  if (on(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (off(env.THREEBOT_TELEMETRY)) return "THREEBOT_TELEMETRY";
  return null;
}

export function bucket(count: number): Bucket {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 10) return "6-10";
  return "11+";
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,48})?$/;
/** A version string, or "other" for anything that doesn't look like one (so free text never leaves). */
export const cleanVersion = (value: unknown): string => typeof value === "string" && VERSION.test(value) ? value : "other";
const OS = new Set(["linux", "darwin", "win32", "freebsd", "openbsd", "android"]);
const ARCH = new Set(["x64", "arm64", "arm", "ia32", "riscv64", "ppc64", "s390x", "loong64"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;
const cleanModel = (value: unknown): string | null => typeof value === "string" && MODEL.test(value) ? value : null;

/** `a >= b` for release versions; pre-release suffixes count as their release. Unparseable is false. */
export function versionAtLeast(a: unknown, b: string): boolean {
  const parse = (v: unknown) => typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) : undefined;
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

// The parts of T3's `orchestration.getThreadProjection` result read here (T3 Code 0.1.5+).
type TurnUsage = { usageStatus?: unknown; inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown; cacheCreationTokens?: unknown; models?: unknown; localCommand?: unknown };
type ProjectionLike = {
  providerTurns?: { runAttemptId?: string | null; completedAt?: string | null; turnTokenUsage?: TurnUsage }[] | null;
  attempts?: { id?: string; runId?: string }[] | null;
  runs?: { id?: string; modelSelection?: { model?: unknown } | null }[] | null;
} | null | undefined;

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/**
 * Token usage per model from Bot thread projections, for provider turns that finished in (since, until].
 * The model is the one T3 Code reported for the turn (0.1.7+), else the run's selected model.
 * `seen` is true when any turn carried `turnTokenUsage`, which tells an older T3 from a quiet day.
 */
export function aggregateTurnUsage(projections: ProjectionLike[], { since, until }: { since: number; until: number }): { seen: boolean; models: Record<string, UsageTotals> } {
  const models = new Map<string, UsageTotals>();
  let seen = false;
  for (const projection of projections) {
    if (!projection || !Array.isArray(projection.providerTurns)) continue;
    const runOfAttempt = new Map((projection.attempts ?? []).map((attempt) => [attempt.id, attempt.runId]));
    const modelOfRun = new Map((projection.runs ?? []).map((run) => [run.id, run.modelSelection?.model]));
    for (const turn of projection.providerTurns) {
      const usage = turn?.turnTokenUsage;
      if (!usage || typeof usage !== "object") continue;
      seen = true;
      const done = Date.parse(turn.completedAt ?? "");
      if (!(done > since && done <= until)) continue;
      if (usage.usageStatus === "unavailable" || usage.localCommand === true) continue;
      const reported = Array.isArray(usage.models) ? usage.models.map(cleanModel).filter((m): m is string => !!m) : [];
      const model = reported.length === 1 ? reported[0] : reported.length > 1 ? "multiple"
        : cleanModel(modelOfRun.get(runOfAttempt.get(turn.runAttemptId ?? undefined))) ?? "unknown";
      const key = models.has(model) || models.size < MAX_MODELS ? model : "other";
      const totals = models.get(key) ?? { turns: 0, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };
      totals.turns += 1;
      totals.inputTokens += count(usage.inputTokens);
      totals.cachedInputTokens += count(usage.cachedInputTokens);
      totals.cacheCreationTokens += count(usage.cacheCreationTokens);
      totals.outputTokens += count(usage.outputTokens);
      models.set(key, totals);
    }
  }
  return { seen, models: Object.fromEntries(models) };
}

/** The ping, built only from the fields listed in PRIVACY.md. Everything is cleaned or bucketed here. */
export function buildPayload(input: PayloadInput): TelemetryPayload {
  return {
    schema: TELEMETRY_SCHEMA,
    installId: input.installId,
    threebot: cleanVersion(input.threebot),
    t3code: input.t3code == null ? null : cleanVersion(input.t3code),
    node: cleanVersion(input.node),
    os: OS.has(input.os) ? input.os : "other",
    arch: ARCH.has(input.arch) ? input.arch : "other",
    bots: bucket(input.bots),
    routines: input.routines == null ? null : bucket(input.routines),
    features: { projects: input.features.projects === true, autoUpdate: input.features.autoUpdate === true, freshSessionRoutines: input.features.freshSessionRoutines === true },
    ...(input.tokens ? { tokens: input.tokens } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/**
 * `collect({ since, until })` gathers this install's numbers (the gateway reads its files and T3).
 * `endpoint` is where pings go; empty means nowhere.
 */
export function createTelemetry({ file, collect, endpoint = process.env.THREEBOT_TELEMETRY_URL || TELEMETRY_ENDPOINT, env = process.env, fetch: post = fetch, now = Date.now, log = () => {} }: {
  file: string;
  collect: (window: { since: number; until: number }) => Promise<PayloadInput>;
  endpoint?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}) {
  let state: TelemetryState | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let sending = false;
  let inflight: AbortController | null = null;
  const blockedBy = envOptOut(env);

  async function read(): Promise<TelemetryState> {
    if (state) return state;
    const saved = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}") || "{}") ?? {};
    state = {
      installId: typeof saved.installId === "string" && UUID.test(saved.installId) ? saved.installId : randomUUID(),
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : null,
      decidedAt: stamp(saved.decidedAt), enabledAt: stamp(saved.enabledAt), lastSentAt: stamp(saved.lastSentAt),
      lastAttemptAt: stamp(saved.lastAttemptAt), lastError: typeof saved.lastError === "string" ? saved.lastError.slice(0, 200) : null,
    };
    return state;
  }
  function update(change: (s: TelemetryState) => Partial<TelemetryState>): Promise<TelemetryState> {
    const next = chain.then(async () => {
      const s = await read();
      state = { ...s, ...change(s) };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
      return state;
    });
    chain = next.catch(() => {});
    return next;
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  /** Tokens since the last ping (or since stats were turned on), never more than a week back. Before that, the last day. */
  function window(s: TelemetryState) {
    const until = now();
    const start = Date.parse(s.lastSentAt ?? s.enabledAt ?? "") || until - SEND_INTERVAL_MS;
    return { since: Math.max(start, until - MAX_WINDOW_MS), until };
  }

  async function status() {
    const s = await read();
    return {
      enabled: s.enabled === true && !blockedBy, choice: s.enabled, asked: s.enabled !== null, blockedBy,
      installId: s.installId, lastSentAt: s.lastSentAt, lastAttemptAt: s.lastAttemptAt, lastError: s.lastError, endpoint: Boolean(endpoint),
    };
  }

  /** Sends one ping when stats are on and the last attempt was a day ago or more. Never throws, never retries sooner. */
  async function tick() {
    if (sending || blockedBy || !endpoint) return;
    sending = true;
    try {
      const s = await read();
      if (s.enabled !== true) return;
      if (s.lastAttemptAt && now() - Date.parse(s.lastAttemptAt) < SEND_INTERVAL_MS) return;
      // Recorded before sending, so a crash or a slow collector can't turn into repeated pings.
      await update(() => ({ lastAttemptAt: iso(now()) }));
      const span = window(s);
      const payload = buildPayload(await collect(span));
      // Collecting can take a while; a user who turned stats off meanwhile gets no ping.
      if ((await read()).enabled !== true) return;
      inflight = new AbortController();
      const response = await post(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), inflight.signal]) });
      if (!response.ok) throw new Error(`collector answered ${response.status}`);
      await update(() => ({ lastSentAt: iso(span.until), lastError: null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`usage stats: not sent (${message})`);
      await update(() => ({ lastError: message.slice(0, 200) })).catch(() => {});
    } finally { sending = false; inflight = null; }
  }

  return {
    status, tick,
    /** Exactly what the next ping would send, gathered now. */
    async preview(): Promise<TelemetryPayload> { return buildPayload(await collect(window(await read()))); },
    async setEnabled(enabled: unknown) {
      if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false"), { status: 400 });
      if (!enabled) inflight?.abort();
      // Turning stats back on starts a new token window but keeps the once-a-day limit (lastAttemptAt).
      await update((s) => ({ enabled, decidedAt: iso(now()), ...(enabled && s.enabled !== true ? { enabledAt: iso(now()), lastSentAt: null } : {}) }));
      return status();
    },
    /** A new random install ID; the next ping looks like a new install. */
    async resetId() { await update(() => ({ installId: randomUUID() })); return status(); },
    /** Checks a minute after startup, then hourly; a ping goes out at most once a day. Timers never keep the process alive. */
    start() {
      const first = setTimeout(() => void tick(), 60_000); first.unref?.();
      const hourly = setInterval(() => void tick(), 60 * 60 * 1000); hourly.unref?.();
      return () => { clearTimeout(first); clearInterval(hourly); };
    },
  };
}
