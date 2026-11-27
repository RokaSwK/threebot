// Bot token usage: a small ledger the gateway appends to every 15 minutes from Bot thread
// projections, and the two API shapes Settings › Usage reads. Counts only — no prompts, no
// thread titles, no transcript paths leave this file.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type UsageSource = "you" | "routine" | "bot";
export type UsageEntry = { key: string; day: string; bot: string; source: UsageSource; model: string; input: number; cached: number; cacheWrite: number; output: number };
export type UsageRow = { day: string; bot: string; source: UsageSource; model: string; input: number; cached: number; cacheWrite: number; output: number; turns: number };
export type UsageLedgerFile = { version: 1; since: string; entries: UsageEntry[] };

// The parts of T3's `orchestration.getThreadProjection` result read here (same turns as telemetry.mts,
// plus the message/run fields that tell a routine or another Bot from the person).
export type UsageProjection = {
  thread?: { id?: unknown } | null;
  threadId?: unknown;
  providerTurns?: { id?: unknown; runAttemptId?: unknown; completedAt?: unknown; turnTokenUsage?: unknown }[] | null;
  messages?: { id?: unknown; scheduledTaskId?: unknown; createdBy?: unknown; creationSource?: unknown }[] | null;
  attempts?: { id?: unknown; runId?: unknown }[] | null;
  runs?: { id?: unknown; userMessageId?: unknown; modelSelection?: { model?: unknown } | null }[] | null;
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set<string>(["you", "routine", "bot"]);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const cost = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const text = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(0, max) : null;
const cleanModel = (value: unknown) => typeof value === "string" && MODEL.test(value) ? value : null;

/** YYYY-MM-DD of an instant in a zone; an unusable zone falls back to UTC. */
export function dayIn(timeZone: string | undefined, ms: number): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

/** The `days` calendar days ending today, oldest first, in the zone. */
export function usageDays(days: number, timeZone: string | undefined, now = Date.now()): { since: string; until: string; days: string[] } {
  const [y, m, d] = dayIn(timeZone, now).split("-").map(Number);
  const list: string[] = [];
  for (let back = (days === 30 ? 30 : 7) - 1; back >= 0; back--) {
    const t = new Date(Date.UTC(y!, m! - 1, d! - back));
    list.push(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`);
  }
  return { since: list[0]!, until: list[list.length - 1]!, days: list };
}

/**
 * The finished provider turns of one projection as ledger entries. `bot` is the Bot's slug; a turn whose
 * run started from a routine message is "routine", one started by an agent or the server is another "bot",
 * and everything else is "you".
 */
export function turnsFromProjection(projection: UsageProjection | null | undefined, { bot, timeZone }: { bot: string; timeZone?: string }): UsageEntry[] {
  if (!projection || !Array.isArray(projection.providerTurns)) return [];
  const threadId = text(projection.thread?.id, 200) ?? text(projection.threadId, 200);
  if (!threadId) return [];
  const runOfAttempt = new Map((projection.attempts ?? []).map((attempt) => [text(attempt.id, 200), text(attempt.runId, 200)]).filter(([id]) => id) as [string, string | null][]);
  const runOfId = new Map((projection.runs ?? []).map((run) => [text(run.id, 200), run]).filter(([id]) => id) as [string, NonNullable<UsageProjection["runs"]>[number]][]);
  const messageOfId = new Map((projection.messages ?? []).map((message) => [text(message.id, 200), message]).filter(([id]) => id) as [string, NonNullable<UsageProjection["messages"]>[number]][]);
  const entries: UsageEntry[] = [];
  for (const turn of projection.providerTurns) {
    if (!turn || typeof turn !== "object") continue;
    const usage = turn.turnTokenUsage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as { usageStatus?: unknown; localCommand?: unknown; inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown; cacheCreationTokens?: unknown; models?: unknown; otherUsage?: { inputTokens?: unknown; outputTokens?: unknown } | null };
    if (u.usageStatus === "unavailable" || u.localCommand === true) continue;
    const completedAt = typeof turn.completedAt === "string" && Number.isFinite(Date.parse(turn.completedAt)) ? turn.completedAt : null;
    if (!completedAt) continue;
    const attemptId = text(turn.runAttemptId, 200);
    const run = runOfId.get(attemptId ? runOfAttempt.get(attemptId) ?? "" : "");
    const message = run ? messageOfId.get(text(run.userMessageId, 200) ?? "") : undefined;
    const source: UsageSource = message?.scheduledTaskId != null && typeof message.scheduledTaskId === "string" ? "routine"
      : message?.createdBy === "agent" || message?.creationSource === "server" ? "bot" : "you";
    const reported = Array.isArray(u.models) ? u.models.map(cleanModel).filter((m): m is string => !!m) : [];
    const model = reported.length === 1 ? reported[0] : reported.length > 1 ? "multiple"
      : cleanModel(run?.modelSelection?.model) ?? "unknown";
    const id = text(turn.id, 200) ?? `${attemptId ?? ""}:${completedAt}`;
    entries.push({
      key: `${threadId}:${id}`, day: dayIn(timeZone, Date.parse(completedAt)), bot: bot.slice(0, 100), source, model,
      // T3's inputTokens already include cache reads and writes; `input` is the uncached part, as in T3's usage summary.
      input: Math.max(0, count(u.inputTokens) - count(u.cachedInputTokens) - count(u.cacheCreationTokens)) + count(u.otherUsage?.inputTokens),
      cached: count(u.cachedInputTokens), cacheWrite: count(u.cacheCreationTokens),
      output: count(u.outputTokens) + count(u.otherUsage?.outputTokens),
    });
  }
  return entries;
}

/**
 * The scan watermark after a pass. Threads count oldest first, and the mark only moves past a thread once it
 * and every older one were read, so a failed, skipped or over-budget thread is read again on the next pass.
 */
export function nextScanWatermark(previous: number, results: readonly { updatedAt: number; read: boolean }[]): number {
  let mark = previous;
  for (const result of [...results].sort((a, b) => a.updatedAt - b.updatedAt)) {
    // Stay below the unread thread: the next pass picks threads updated after the mark.
    if (!result.read) return Math.max(previous, Math.min(mark, result.updatedAt - 1));
    if (result.updatedAt > mark) mark = result.updatedAt;
  }
  return mark;
}

const validEntry = (value: unknown): value is UsageEntry => {
  if (!value || typeof value !== "object") return false;
  const e = value as UsageEntry;
  return typeof e.key === "string" && e.key.length > 0 && e.key.length <= 500
    && typeof e.day === "string" && DAY.test(e.day)
    && typeof e.bot === "string" && e.bot.length > 0 && e.bot.length <= 100
    && typeof e.source === "string" && SOURCES.has(e.source)
    && typeof e.model === "string" && e.model.length > 0 && e.model.length <= 100
    && count(e.input) === e.input && count(e.cached) === e.cached && count(e.cacheWrite) === e.cacheWrite && count(e.output) === e.output;
};

/**
 * Older ledgers could count every thread in a shared project. Hide only entries whose source thread
 * is still known and confirmed to be outside that adopted Bot's ownership.
 */
export function usageEntryFilter(
  sharedProjects: ReadonlyMap<string, string>,
  threads: ReadonlyMap<string, { projectId?: string | null; owner?: string }>,
): (entry: UsageEntry) => boolean {
  return (entry) => {
    const project = sharedProjects.get(entry.bot);
    if (!project) return true;
    let thread: { projectId?: string | null; owner?: string } | undefined;
    // Thread IDs may include colons. Use the longest known prefix before the turn ID.
    for (let i = entry.key.indexOf(":"); i >= 0; i = entry.key.indexOf(":", i + 1)) {
      thread = threads.get(entry.key.slice(0, i)) ?? thread;
    }
    return !thread || thread.projectId !== project || thread.owner === entry.bot;
  };
}

const PRUNE_DAYS = 90 * 24 * 60 * 60 * 1000;

export function createUsageLedger({ file, now = Date.now }: { file: string; now?: () => number }) {
  let state: UsageLedgerFile | null = null;
  const load = async (): Promise<UsageLedgerFile> => {
    if (state) return state;
    let raw: string | null = null;
    let saved: UsageLedgerFile | null = null;
    try { raw = await fs.readFile(file, "utf8"); } catch { /* No ledger yet. */ }
    try { saved = raw === null ? null : JSON.parse(raw); } catch { /* Handled below. */ }
    const valid = !!saved && saved.version === 1 && typeof saved.since === "string" && Array.isArray(saved.entries);
    if (raw !== null && !valid) {
      // Keep an unreadable ledger for inspection instead of overwriting it on the next save.
      await fs.rename(file, `${file}.broken`).catch(() => {});
      console.log(`usage ledger: unreadable file moved to ${path.basename(file)}.broken; starting a new one`);
    }
    state = valid && saved
      ? { version: 1, since: saved.since, entries: saved.entries.filter(validEntry) }
      : { version: 1, since: new Date(now()).toISOString(), entries: [] };
    return state;
  };
  return {
    load,
    /** Merges entries by key (the newest read of a turn wins) and drops anything older than 90 days. */
    async add(entries: readonly UsageEntry[]) {
      const s = await load();
      const byKey = new Map(s.entries.map((entry) => [entry.key, entry]));
      for (const entry of entries) if (validEntry(entry)) byKey.set(entry.key, entry);
      // An entry's key is the record that its turn was counted, so it goes when the entry does.
      const cutoff = new Date(now() - PRUNE_DAYS).toISOString().slice(0, 10);
      s.entries = [...byKey.values()].filter((entry) => entry.day >= cutoff);
    },
    save: async () => {
      const s = await load();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(s) + "\n", { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    },
    /** Totals per day, Bot, source and model over the last 7 or 30 days in the zone. */
    async rows({ days, timeZone, include }: { days: number; timeZone?: string; include?: (entry: UsageEntry) => boolean }) {
      const s = await load();
      let zone = timeZone?.trim() || undefined;
      try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); } catch { zone = undefined; }
      const { since, until, days: list } = usageDays(days, zone, now());
      const totals = new Map<string, UsageRow>();
      for (const entry of s.entries) {
        if (entry.day < since || entry.day > until || include?.(entry) === false) continue;
        const key = `${entry.day}|${entry.bot}|${entry.source}|${entry.model}`;
        const row = totals.get(key) ?? { day: entry.day, bot: entry.bot, source: entry.source, model: entry.model, input: 0, cached: 0, cacheWrite: 0, output: 0, turns: 0 };
        row.input += entry.input; row.cached += entry.cached; row.cacheWrite += entry.cacheWrite; row.output += entry.output; row.turns += 1;
        totals.set(key, row);
      }
      return { since, until, timeZone: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, ledgerSince: s.since, days: list, rows: [...totals.values()] };
    },
  };
}

const windowsHome = (home: string) => process.platform === "win32" || /^(?:[a-z]:[/\\]|[/\\]{2}[^/\\])/i.test(home);

/**
 * A transcript root as a provider label, or null when it isn't one of the known homes (the caller then
 * shows T3's provider kind instead). Never returns a path.
 */
export function providerForSourcePath(sourcePath: unknown, home: string = homedir()): string | null {
  if (typeof sourcePath !== "string") return null;
  const win = windowsHome(home);
  const separators = (value: string) => win ? value.replace(/\\/g, "/") : value;
  const root = separators(home).replace(/\/+$/, "");
  const source = separators(sourcePath);
  const matchesHome = root && (win
    ? source.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : source.startsWith(`${root}/`));
  const relative = matchesHome ? `~${source.slice(root.length)}` : source;
  const p = win ? relative.toLowerCase() : relative;
  const namedRoot = /^~\/\.claude-([^/]{1,64})\/projects(?:\/|$)/;
  const named = (win ? new RegExp(namedRoot.source, "i") : namedRoot).exec(relative);
  if (named) return `Claude (${named[1]})`;
  if (/^~\/\.claude\/projects(?:\/|$)/.test(p)) return "Claude";
  if (/^~\/\.codex\/(?:archived_)?sessions(?:\/|$)/.test(p)) return "Codex";
  if (/^~\/\.grok(?:\/|$)/.test(p)) return "Grok";
  return null;
}

export type AccountUsage = { account: string; input: number; cached: number; cacheWrite: number; output: number; costUsd: number; unpricedRecords: number };

/** T3's usage-summary buckets as per-account totals; transcript paths become labels here, never in the browser. */
export function accountsFromBuckets(buckets: unknown, home: string = homedir()): AccountUsage[] {
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const totals = new Map<string, AccountUsage>();
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!bucket || typeof bucket !== "object") continue;
    const b = bucket as { sourcePath?: unknown; provider?: unknown; costUsd?: unknown; unpricedRecords?: unknown; totals?: { uncachedInputTokens?: unknown; cachedInputTokens?: unknown; cacheCreationTokens?: unknown; outputTokens?: unknown } | null };
    const t = b.totals ?? {};
    const account = providerForSourcePath(b.sourcePath, home) ?? (typeof b.provider === "string" && b.provider.trim() ? b.provider.trim().slice(0, 60) : "Unknown");
    const key = windowsHome(home) ? account.toLowerCase() : account;
    const row = totals.get(key) ?? { account, input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0, unpricedRecords: 0 };
    row.input += num(t.uncachedInputTokens); row.cached += num(t.cachedInputTokens); row.cacheWrite += num(t.cacheCreationTokens); row.output += num(t.outputTokens); row.costUsd += num(b.costUsd);
    row.unpricedRecords += Number.isSafeInteger(b.unpricedRecords) ? num(b.unpricedRecords) : 0;
    totals.set(key, row);
  }
  return [...totals.values()];
}

export type UsageBudget = {
  maxTokens?: number | null;
  maxCostUsd?: number | null;
  warnRatio?: number;
  autoPause?: boolean;
};

export type BudgetEvaluation = {
  state: "ok" | "warning" | "exceeded";
  shouldAutoPause: boolean;
  reason: string | null;
};

/** Evaluates current usage against an optional token or USD budget for soft warnings and circuit-breaking. */
export function evaluateBudget(
  totals: { tokens: number; costUsd: number },
  budget?: UsageBudget | null,
): BudgetEvaluation {
  if (!budget) return { state: "ok", shouldAutoPause: false, reason: null };
  const warnRatio = typeof budget.warnRatio === "number" && budget.warnRatio > 0 && budget.warnRatio < 1 ? budget.warnRatio : 0.8;
  const checks: Array<{ ratio: number; label: string }> = [];
  if (typeof budget.maxTokens === "number" && budget.maxTokens > 0) {
    checks.push({ ratio: totals.tokens / budget.maxTokens, label: `token budget (${totals.tokens.toLocaleString()} / ${budget.maxTokens.toLocaleString()})` });
  }
  if (typeof budget.maxCostUsd === "number" && budget.maxCostUsd > 0) {
    checks.push({ ratio: totals.costUsd / budget.maxCostUsd, label: `cost budget ($${totals.costUsd.toFixed(2)} / $${budget.maxCostUsd.toFixed(2)})` });
  }
  const worst = checks.sort((a, b) => b.ratio - a.ratio)[0];
  if (!worst || worst.ratio < warnRatio) return { state: "ok", shouldAutoPause: false, reason: null };
  if (worst.ratio >= 1) {
    return { state: "exceeded", shouldAutoPause: budget.autoPause === true, reason: `Exceeded ${worst.label}` };
  }
  return { state: "warning", shouldAutoPause: false, reason: `Approaching ${worst.label}` };
}
