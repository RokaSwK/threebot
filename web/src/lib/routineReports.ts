// A routine that lives in a conversation of its own leaves one line in the Bot's chat: the last
// run's report, read from its thread. It is never a model turn, so it cannot wake the Bot.
import { threadClient } from "./t3";
import type { Bot, ScheduledTask, TurnItem } from "./types";

export type RoutineReport = { id: string; at: string; title: string; summary: string; threadId: string; failed: boolean };

const firstParagraph = (text: string) => {
  const first = text.trim().split(/\n{2,}/u)[0].replace(/\s+/gu, " ").trim();
  if (first.length <= 180) return first;
  // Cut at a word: a summary ending mid-word reads as a truncated error, not a report.
  const cut = first.slice(0, 179);
  const space = cut.lastIndexOf(" ");
  return `${(space > 120 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * The routines whose runs leave this Bot's chat: its own project, a conversation of their own, and a run.
 * T3 streams every project's routines, so the project is what keeps another Bot's lines out of this chat.
 * Newest first; the chat shows only the latest few.
 */
export function ownConversationRoutines(bot: Bot, tasks: ScheduledTask[], limit = 5): ScheduledTask[] {
  if (!bot.projectId) return [];
  return tasks
    .filter((task) => task.projectId === bot.projectId && task.threadId && task.threadId !== bot.mainThreadId && (task.runCount ?? 0) > 0)
    .sort((left, right) => (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? ""))
    .slice(0, Math.max(1, limit));
}

const reportKey = (task: ScheduledTask) => `${task.id}:${task.threadId}:${task.lastRunAt}:${task.runCount ?? 0}:${task.lastRunStatus}`;
// Keyed by the run that produced it: a new run gets a new key, so the cache never serves a stale line.
const reports = new Map<string, RoutineReport | null>();

/** The report of one routine, or a line that says the run happened when its text cannot be read. */
export async function readRoutineReport(task: ScheduledTask): Promise<RoutineReport | null> {
  if (!task.threadId) return null;
  const cached = reports.get(reportKey(task));
  if (cached !== undefined) return cached;
  const base = { id: task.id, title: task.title, threadId: task.threadId };
  if (task.lastRunStatus === "running") {
    const report = { ...base, at: task.lastRunAt ?? new Date().toISOString(), summary: "Running now, in its own conversation.", failed: false };
    reports.set(reportKey(task), report);
    return report;
  }
  if (task.lastRunStatus === "failed") {
    const report = { ...base, at: task.lastRunAt ?? new Date().toISOString(), summary: "The run failed. Open it for details.", failed: true };
    reports.set(reportKey(task), report);
    return report;
  }
  if (!task.lastRunAt) return null;
  let report: RoutineReport;
  try {
    const projection = await threadClient(task.threadId).call<{ turnItems?: TurnItem[] }>("orchestration.getThreadProjection", { threadId: task.threadId });
    const message = [...(projection?.turnItems ?? [])].reverse().find((item) => item.type === "assistant_message" && typeof item.text === "string" && item.text.trim());
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    // A moved routine always leaves one line: silence would claim nothing ran.
    report = { ...base, at: task.lastRunAt, summary: text ? firstParagraph(text) : "Ran in its own conversation.", failed: false };
  } catch {
    // Not cached: a failed read gets another chance on the next chat load.
    return { ...base, at: task.lastRunAt, summary: "Ran in its own conversation.", failed: false };
  }
  reports.set(reportKey(task), report);
  if (reports.size > 50) {
    const oldest = reports.keys().next().value;
    if (oldest !== undefined) reports.delete(oldest);
  }
  return report;
}

export async function readRoutineReports(bot: Bot, tasks: ScheduledTask[], limit = 5): Promise<RoutineReport[]> {
  const settled = await Promise.allSettled(ownConversationRoutines(bot, tasks, limit).map(readRoutineReport));
  return settled.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
}
