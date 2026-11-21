// A routine that lives in a conversation of its own leaves one line in the Bot's chat: the last
// run's report, read from its thread. It is never a model turn, so it cannot wake the Bot.
import { threadClient } from "./t3";
import { findTidyTask } from "./memoryTidy";
import { ROUTINE_THREAD_PREFIX } from "./routines";
import type { Bot, ScheduledTask, ThreadShell, TurnItem } from "./types";

export type RoutineReport = { id: string; at: string; title: string; summary: string; threadId: string; failed: boolean };
type Threads = Record<string, ThreadShell | undefined>;

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
 * Whether the routine's thread is a conversation of its own that has run: one Threebot started for it,
 * or the memory tidy's (T3 starts that one). A routine bound to any other thread, a room or one of the
 * user's own in a project Bot, leaves no line. A conversation it was just moved to has not run yet, so
 * the run T3 last recorded happened somewhere else. Without the thread's shell nothing is known.
 */
function ownConversation(task: ScheduledTask, thread: ThreadShell | undefined, tidyId: string | undefined) {
  if (!thread || thread.archivedAt || !thread.latestRunId) return false;
  return task.id === tidyId || thread.id.startsWith(ROUTINE_THREAD_PREFIX);
}

/**
 * The routines whose runs leave this Bot's chat a line: its own project, a conversation of their own,
 * and a run. T3 streams every project's routines, so the project is what keeps another Bot's lines out
 * of this chat. Newest first; the chat shows only the latest few.
 */
export function ownConversationRoutines(bot: Bot, tasks: ScheduledTask[], threads: Threads, limit = 5): ScheduledTask[] {
  if (!bot.projectId) return [];
  const tidyId = findTidyTask(bot, tasks)?.id;
  return tasks
    .filter((task) => task.projectId === bot.projectId && task.threadId && task.threadId !== bot.mainThreadId && (task.runCount ?? 0) > 0 && ownConversation(task, threads[task.threadId], tidyId))
    .sort((left, right) => (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? ""))
    .slice(0, Math.max(1, limit));
}

/**
 * What a report depends on. T3's task only records the dispatch ("succeeded" once the message is
 * sent), so the thread's own run state is what says when the reply has landed.
 */
export function reportKey(task: ScheduledTask, thread: ThreadShell | undefined) {
  return [task.id, task.threadId, task.lastRunAt, task.runCount ?? 0, task.lastRunStatus, task.lastRunError ?? "", thread?.latestRunId ?? "", thread?.activityRunStatus ?? thread?.status ?? "", thread?.latestRunCompletedAt ?? "", thread?.pendingRuntimeRequest?.id ?? ""].join(":");
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

/** The report of one routine, or a line that says the run happened when its text cannot be read. */
export async function readRoutineReport(task: ScheduledTask, thread?: ThreadShell): Promise<RoutineReport | null> {
  if (!task.threadId) return null;
  const key = reportKey(task, thread);
  const cached = reports.get(key);
  if (cached !== undefined) return cached;
  const base = { id: task.id, title: task.title, threadId: task.threadId };
  const at = task.lastRunAt ?? new Date().toISOString();
  // A run that asks for approval waits in its own conversation; the chat is where the user would see that.
  if (thread?.pendingRuntimeRequest) return remember(key, { ...base, at, summary: "Waiting for you in its own conversation.", failed: false });
  if (task.lastRunStatus === "running" || ACTIVE.has(thread?.activityRunStatus ?? thread?.status ?? "")) return remember(key, { ...base, at, summary: "Running now, in its own conversation.", failed: false });
  if (task.lastRunStatus === "failed") {
    const reason = task.lastRunError?.trim();
    return remember(key, { ...base, at, summary: reason ? `The run failed: ${firstParagraph(reason)}` : "The run failed. Open it for details.", failed: true });
  }
  if (!task.lastRunAt) return null;
  try {
    const projection = await threadClient(task.threadId).call<{ turnItems?: TurnItem[] }>("orchestration.getThreadProjection", { threadId: task.threadId });
    const message = [...(projection?.turnItems ?? [])].reverse().find((item) => item.type === "assistant_message" && typeof item.text === "string" && item.text.trim());
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    // A moved routine always leaves one line: silence would claim nothing ran.
    return remember(key, { ...base, at: task.lastRunAt, summary: text ? firstParagraph(text) : "Ran in its own conversation.", failed: false });
  } catch {
    // Not cached: a failed read gets another chance on the next chat load.
    return { ...base, at: task.lastRunAt, summary: "Ran in its own conversation.", failed: false };
  }
}

export async function readRoutineReports(bot: Bot, tasks: ScheduledTask[], threads: Threads, limit = 5): Promise<RoutineReport[]> {
  const settled = await Promise.allSettled(ownConversationRoutines(bot, tasks, threads, limit).map((task) => readRoutineReport(task, task.threadId ? threads[task.threadId] : undefined)));
  return settled.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
}
