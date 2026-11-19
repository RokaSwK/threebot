import type { TidyFrequency } from "./memory";
import type { Bot, ScheduledTask } from "./types";

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
