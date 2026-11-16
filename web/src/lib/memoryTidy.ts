import { threadClient } from "./t3";
import type { TidyFrequency } from "./memory";
import type { Bot, ScheduledTask, TurnItem } from "./types";

/** The title T3 stores for the routine; the link is normally the id in bot.json. */
export const MEMORY_TIDY_TITLE = "Tidy memory";

export type TidyState = TidyFrequency | "custom";

/** The linked routine, or one made before the id was stored. */
export function findTidyTask(bot: Bot, tasks: ScheduledTask[]): ScheduledTask | undefined {
  const linked = typeof bot.memoryTidyRoutineId === "string" ? bot.memoryTidyRoutineId : null;
  return tasks.find((task) => task.id === linked)
    ?? tasks.find((task) => task.title === MEMORY_TIDY_TITLE && task.projectId === bot.projectId);
}

/** Off when paused; weekly and nightly are the two presets; anything else is shown as custom. */
export function tidyState(task: ScheduledTask | undefined): TidyState {
  if (!task?.enabled) return "off";
  if (task.schedule.type !== "fixed_time") return "custom";
  const days = task.schedule.weekdays;
  if (Array.isArray(days) && days.length === 1 && days[0] === 1) return "weekly";
  if (!Array.isArray(days) || days.length === 0 || days.length === 7) return "nightly";
  return "custom";
}

export function tidyScheduleText(state: TidyState): string {
  if (state === "weekly") return "Mondays at 03:30";
  if (state === "nightly") return "Every night at 03:30";
  if (state === "custom") return "On its own schedule";
  return "Only when you ask";
}

export type TidyReport = { id: string; at: string; title: string; summary: string; threadId: string; failed: boolean };

const firstParagraph = (text: string) => {
  const first = text.trim().split(/\n{2,}/u)[0].replace(/\s+/gu, " ").trim();
  return first.length > 180 ? `${first.slice(0, 179).trimEnd()}…` : first;
};

/**
 * The report the routine left in its own conversation, for the chat's synthetic line. T3 has no
 * "post a note without a turn", so this never sends anything to the Bot's thread.
 */
export async function readTidyReport(task: ScheduledTask): Promise<TidyReport | null> {
  if (!task.threadId || !task.lastRunAt || !task.runCount) return null;
  if (task.lastRunStatus === "failed") {
    return { id: task.id, at: task.lastRunAt, title: task.title, summary: "The run failed. Open it for details.", threadId: task.threadId, failed: true };
  }
  if (task.lastRunStatus === "running") return null;
  const projection = await threadClient(task.threadId).call<{ turnItems?: TurnItem[] }>("orchestration.getThreadProjection", { threadId: task.threadId });
  const message = [...(projection?.turnItems ?? [])].reverse().find((item) => item.type === "assistant_message" && typeof item.text === "string" && item.text.trim());
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text) return null;
  return { id: task.id, at: task.lastRunAt, title: task.title, summary: firstParagraph(text), threadId: task.threadId, failed: false };
}
