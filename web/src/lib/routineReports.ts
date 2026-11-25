// A routine that runs outside the Bot's chat leaves one line in that chat: the last run's report,
// read from the conversation it ran in. It is never a model turn, so it cannot wake the Bot.
import { threadClient } from "./t3";
import { routineHistory, threadMode } from "./routines";
import { routineOwner, routinePlace, type RoutineRecord } from "./routineAlerts";
import type { Bot, ScheduledTask, ThreadShell, TurnItem } from "./types";

export type RoutineReportState = "finished" | "failed" | "stopped" | "waiting" | "running" | "unavailable";
export type RoutineReport = {
  id: string;
  at: string;
  title: string;
  summary: string;
  /** The conversation the run happened in; null when it never reached one or could not be found. */
  threadId: string | null;
  state: RoutineReportState;
  /** The Bot whose routine this is, when the line is shown outside that Bot's own context. */
  bot: string;
};
type Threads = Record<string, ThreadShell | undefined>;
/** A message of T3's thread projection; `scheduledTaskId` is set on the ones a routine sent. */
type ProjectionMessage = { id: string; runId?: string | null; scheduledTaskId?: string | null };
type ProjectionRun = { id: string; userMessageId?: string | null; status?: string | null; requestedAt?: string | null; startedAt?: string | null; completedAt?: string | null };
type Projection = { messages?: ProjectionMessage[]; turnItems?: TurnItem[]; runs?: ProjectionRun[] };

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const firstParagraph = (text: string) => {
  const first = text.trim().split(/\n{2,}/u)[0].replace(/\s+/gu, " ").trim();
  if (first.length <= 180) return first;
  // Cut at a word: a summary ending mid-word reads as a truncated error, not a report.
  const cut = first.slice(0, 179);
  const space = cut.lastIndexOf(" ");
  return `${(space > 120 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * The routines whose runs leave this Bot's chat a line: owned by it (an explicit link, or a project
 * with exactly one Bot), running somewhere other than the chat, and having run at least once.
 * A shared project alone is not ownership, so an ambiguous routine appears in nobody's chat.
 * Newest first; the chat shows only the latest few.
 */
export function ownConversationRoutines(bot: Bot, tasks: ScheduledTask[], threads: Threads, bots: Bot[] = [bot], records: Record<string, RoutineRecord> = {}, limit = 5): ScheduledTask[] {
  if (!bot.projectId) return [];
  return tasks
    .filter((task) => {
      if (task.projectId !== bot.projectId || (task.runCount ?? 0) <= 0) return false;
      if (routinePlace(task, bot) === "chat") return false;
      const owner = routineOwner(task, bots, records);
      if (owner.kind !== "bot" || owner.bot.slug !== bot.slug) return false;
      // A bound conversation must be known and have run. A routine just moved there has not; the
      // run T3 recorded happened somewhere else, and attributing it to this thread would be false.
      if (task.threadId) {
        const thread = threads[task.threadId];
        if (!thread || thread.archivedAt || !thread.latestRunId) return false;
      }
      return true;
    })
    .sort((left, right) => (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? ""))
    .slice(0, Math.max(1, limit));
}

/** What a report depends on: the task, its conversation's run state, and a new-thread run's target. */
export function reportKey(task: ScheduledTask, thread: ThreadShell | undefined, threadId: string | null = task.threadId ?? null) {
  return [task.id, threadId ?? "", task.lastRunAt, task.runCount ?? 0, task.lastRunStatus, thread?.latestRunId ?? "", thread?.activityRunStatus ?? thread?.status ?? "", thread?.latestRunCompletedAt ?? "", thread?.pendingRuntimeRequest?.id ?? ""].join(":");
}
// Keyed by the run that produced it: a new run or its reply gets a new key, so the cache never serves a stale line.
const reports = new Map<string, RoutineReport | null>();
const remember = (key: string, report: RoutineReport) => {
  reports.set(key, report);
  if (reports.size > 50) {
    const oldest = reports.keys().next().value;
    if (oldest !== undefined) reports.delete(oldest);
  }
  return report;
};

/**
 * The conversation a new-thread run used. T3 keeps no pointer from the task to it, so the gateway's
 * bounded history read (task → message → run) is the only honest source. Nothing is inferred from
 * a project-relative thread list here.
 */
const latestThreads = new Map<string, { key: string; value: { threadId: string; runId: string; status: string } }>();
// T3's task says when the dispatch happened; a run that started before it belongs to a previous
// dispatch. A small allowance covers the timestamp rounding between the task and its run.
const DISPATCH_SKEW_MS = 5_000;
async function newThreadRun(task: ScheduledTask): Promise<{ threadId: string; runId: string; status: string } | null> {
  if (threadMode(task) !== "new_thread" || (task.runCount ?? 0) <= 0 || !task.lastRunAt) return null;
  const cacheKey = `${task.id}:${task.lastRunAt}`;
  const cached = latestThreads.get(task.id);
  if (cached?.key === cacheKey) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const history = await routineHistory(task.id, controller.signal);
    const since = Date.parse(task.lastRunAt) - DISPATCH_SKEW_MS;
    const latest = history.rows
      .filter((row) => row.source === "execution" && row.threadId && Date.parse(row.at) >= since)
      .sort((left, right) => right.at.localeCompare(left.at))[0];
    // No matching row means history has not caught up with this dispatch yet. Do not cache a
    // miss: the next read must be able to pick up the new execution instead of keeping a null.
    if (!latest?.threadId) return null;
    const value = { threadId: latest.threadId, runId: latest.runId ?? "", status: latest.status };
    latestThreads.set(task.id, { key: cacheKey, value });
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The report of one routine. Text is attributable or absent; it is never another run's reply. */
export async function readRoutineReport(task: ScheduledTask, thread?: ThreadShell, resolved?: { threadId: string; runId: string; status: string } | null): Promise<RoutineReport | null> {
  const historyRun = task.threadId || resolved ? null : await newThreadRun(task);
  const target = task.threadId ?? resolved?.threadId ?? historyRun?.threadId ?? null;
  const key = reportKey(task, thread, target);
  const cached = reports.get(key);
  if (cached !== undefined) return cached;
  const base = { id: task.id, title: task.title, bot: "" };
  const at = task.lastRunAt ?? new Date().toISOString();
  if (!target) {
    // A dispatch failure never opened a conversation; saying where it ran would be invented.
    if (task.lastRunStatus === "failed") {
      const reason = task.lastRunError?.trim();
      return remember(key, { ...base, at, threadId: null, state: "failed", summary: reason ? `The run failed: ${firstParagraph(reason)}` : "The run failed before it reached a conversation." });
    }
    if (task.lastRunStatus === "running") return remember(key, { ...base, at, threadId: null, state: "running", summary: "Running in a new conversation." });
    // A new-thread run whose conversation the bounded history could not find still leaves an
    // honest line: silence would claim nothing ran, and a guessed thread would open the wrong one.
    if (threadMode(task) === "new_thread") return remember(key, { ...base, at, threadId: null, state: "unavailable", summary: "A run was dispatched, but its conversation could not be found." });
    return null;
  }
  let projection: Projection | null = null;
  try {
    projection = await threadClient(target).call<Projection>("orchestration.getThreadProjection", { threadId: target });
  } catch {
    // Not cached: a failed read gets another chance on the next chat load. Say that the result
    // could not be read instead of borrowing a state from the thread, which may be a manual turn.
    return { ...base, at, threadId: target, state: "unavailable", summary: "Result unavailable. Open the conversation for details." };
  }
  const runRows = projection?.runs ?? [];
  const requestedAt = (runId: string | null | undefined) => runRows.find((entry) => entry.id === runId)?.requestedAt ?? "";
  const newestRun = [...runRows].filter((entry) => typeof entry.id === "string" && entry.id)
    .sort((left, right) => String(left.requestedAt ?? "").localeCompare(String(right.requestedAt ?? ""))).at(-1);
  // The run the thread is showing now. The user can chat in a routine's own thread, so a current
  // run without this task's message is a manual turn, not the routine running or waiting.
  const currentRunId = thread?.latestRunId ?? newestRun?.id ?? resolved?.runId ?? null;
  const routineMessages = (projection?.messages ?? [])
    .filter((item) => item.scheduledTaskId === task.id && typeof item.runId === "string" && item.runId);
  const currentMessage = currentRunId ? routineMessages.find((item) => item.runId === currentRunId) : undefined;
  const currentRun = currentRunId ? runRows.find((entry) => entry.id === currentRunId) : undefined;
  const currentAt = currentRun?.startedAt ?? currentRun?.requestedAt ?? task.lastRunAt ?? at;
  if (thread?.pendingRuntimeRequest) {
    if (!currentMessage) return null;
    return remember(key, { ...base, at: currentAt, threadId: target, state: "waiting", summary: "Waiting for you in its conversation." });
  }
  if (ACTIVE.has(thread?.activityRunStatus ?? thread?.status ?? "")) {
    if (!currentMessage) return null;
    return remember(key, { ...base, at: currentAt, threadId: target, state: "running", summary: "Running now, in its conversation." });
  }
  // A terminal manual run does not erase the routine's last own result; without run rows there is
  // no honest way to order several routine messages, so the result stays unavailable.
  const message = currentMessage ?? (routineMessages.length === 1 ? routineMessages[0] : runRows.length ? [...routineMessages].sort((left, right) => requestedAt(right.runId).localeCompare(requestedAt(left.runId)))[0] : undefined);
  const runId = message?.runId ?? resolved?.runId ?? null;
  if (!runId) {
    // A persisted new-thread execution is evidence that the routine ran there, even when this
    // projection cannot be read. An own-thread projection with no routine message may be a manual
    // conversation, so it leaves no line at all.
    if (resolved || historyRun) return remember(key, { ...base, at, threadId: target, state: "unavailable", summary: "Result unavailable. Open the conversation for details." });
    return null;
  }
  const run = runRows.find((entry) => entry.id === runId);
  const status = run?.status ?? (currentMessage ? thread?.status === "completed" ? "completed" : thread?.status ?? resolved?.status ?? "" : resolved?.status ?? "");
  const runAt = run?.completedAt ?? run?.startedAt ?? run?.requestedAt ?? task.lastRunAt ?? at;
  if (status === "failed") {
    return remember(key, { ...base, at: runAt, threadId: target, state: "failed", summary: "The run failed. Open the conversation for details." });
  }
  if (status === "cancelled" || status === "interrupted" || status === "rolled_back") {
    return remember(key, { ...base, at: runAt, threadId: target, state: "stopped", summary: "The run was stopped before it could report." });
  }
  if (ACTIVE.has(status)) return remember(key, { ...base, at: runAt, threadId: target, state: "running", summary: "Running now, in its conversation." });
  const reply = [...(projection?.turnItems ?? [])].reverse().find((item) => item.type === "assistant_message" && item.runId === runId && typeof item.text === "string" && item.text.trim());
  const text = typeof reply?.text === "string" ? reply.text.trim() : "";
  if (!text) return remember(key, { ...base, at: runAt, threadId: target, state: "finished", summary: "The run finished without a written report." });
  return remember(key, { ...base, at: runAt, threadId: target, state: status === "completed" || !status ? "finished" : "unavailable", summary: text ? firstParagraph(text) : "Result unavailable. Open the conversation for details." });
}

export async function readRoutineReports(bot: Bot, tasks: ScheduledTask[], threads: Threads, bots: Bot[] = [bot], records: Record<string, RoutineRecord> = {}, limit = 5): Promise<RoutineReport[]> {
  const settled = await Promise.allSettled(ownConversationRoutines(bot, tasks, threads, bots, records, limit).map(async (task) => {
    const report = await readRoutineReport(task, task.threadId ? threads[task.threadId] : undefined);
    return report ? { ...report, bot: bot.slug } : null;
  }));
  return settled.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
}
