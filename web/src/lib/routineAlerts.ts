// Per-routine alerts and ownership, mirrored from the gateway's store. The server owns the record;
// this module only reads it, decides what the defaults mean, and writes one field at a time.
import type { Bot, ScheduledTask } from "./types";

export type RoutineAlertKind = "finished" | "failed" | "waiting";
export type RoutineAlerts = Record<RoutineAlertKind, boolean>;
export type RoutineRecord = { bot?: string; alerts?: Partial<RoutineAlerts> };
/** Where T3 runs a routine: the Bot's chat, its own conversation, or a new one each run. */
export type RoutinePlace = "chat" | "own" | "new";
export type RoutineOwner = { kind: "bot"; bot: Bot } | { kind: "ambiguous" } | { kind: "none" };

export function routinePlace(task: Pick<ScheduledTask, "threadId" | "threadMode">, bot: Pick<Bot, "mainThreadId">): RoutinePlace {
  const mode = task.threadMode ?? (task.threadId === null ? "new_thread" : "continue");
  if (mode === "new_thread") return "new";
  return task.threadId && task.threadId === bot.mainThreadId ? "chat" : "own";
}

/**
 * What a routine's runs did before per-routine alerts existed: a run in the Bot's chat finished and
 * waited with the Bot; its own conversation and a new thread each run were silent. A record only
 * overrides the toggles it names.
 */
export function defaultAlerts(place: RoutinePlace): RoutineAlerts {
  return place === "chat" ? { finished: true, failed: false, waiting: true } : { finished: false, failed: false, waiting: false };
}

export function effectiveAlerts(record: RoutineRecord | null | undefined, place: RoutinePlace): RoutineAlerts {
  const alerts = defaultAlerts(place);
  for (const kind of ["finished", "failed", "waiting"] as const) {
    const stored = record?.alerts?.[kind];
    if (typeof stored === "boolean") alerts[kind] = stored;
  }
  return alerts;
}

export function anyAlert(alerts: RoutineAlerts): boolean {
  return alerts.finished || alerts.failed || alerts.waiting;
}

/**
 * Which Bot owns a routine. A Bot's own chat and its tidy routine are proof; an explicit link
 * resolves the ambiguous cases. A project fallback is only a project Threebot created for one Bot:
 * an adopted project with a single Bot still contains the user's own threads and rooms.
 */
export function routineOwner(task: Pick<ScheduledTask, "id" | "projectId" | "threadId">, bots: Bot[], records: Record<string, RoutineRecord>): RoutineOwner {
  // A run bound to a Bot's chat is that Bot's; a link only resolves the cases the thread cannot.
  if (task.threadId) {
    const byChat = bots.find((bot) => bot.mainThreadId === task.threadId);
    if (byChat) return { kind: "bot", bot: byChat };
  }
  const tidy = bots.find((bot) => bot.memoryTidyRoutineId === task.id && (!bot.projectId || !task.projectId || bot.projectId === task.projectId));
  if (tidy) return { kind: "bot", bot: tidy };
  const linked = records[task.id]?.bot;
  if (linked) {
    const bot = bots.find((entry) => entry.slug === linked);
    // A link only resolves an ambiguous project; a stale link to another project is not proof.
    if (bot && (!bot.projectId || !task.projectId || bot.projectId === task.projectId)) return { kind: "bot", bot };
  }
  const candidates = bots.filter((bot) => !!bot.projectId && bot.projectId === task.projectId);
  // An adopted project is the user's own even when this install has one Bot in it.
  if (candidates.length === 1 && candidates[0].adopted !== true) return { kind: "bot", bot: candidates[0] };
  return candidates.length > 0 ? { kind: "ambiguous" } : { kind: "none" };
}

/** Whether a task belongs in this Bot's Details: its own routines and the ambiguous ones it can link. */
export function taskForBot(task: Pick<ScheduledTask, "id" | "projectId" | "threadId">, bot: Bot, bots: Bot[], records: Record<string, RoutineRecord>): boolean {
  if (task.projectId !== bot.projectId) return false;
  const owner = routineOwner(task, bots, records);
  return owner.kind === "ambiguous" || (owner.kind === "bot" && owner.bot.slug === bot.slug);
}

/** The notification tag for a routine's completion: one notice per routine, not per Bot.
 * Deliberate grouping: runs of the same routine replace one notice; another routine is untouched. */
export function routineTag(taskId: string): string {
  return `routine:${taskId}`;
}

export function routineTarget(slug: string, taskId: string, threadId: string) {
  return { tag: routineTag(taskId), url: `/?bot=${encodeURIComponent(slug)}&thread=${encodeURIComponent(threadId)}` };
}

export type RoutineRunRef = { threadId: string; runId: string; at: string; status: string };

/** The newest observed conversation per task, from the gateway's persisted refs (never T3 content). */
export async function loadRoutineRuns(taskIds: string[]): Promise<Record<string, RoutineRunRef>> {
  const ids = [...new Set(taskIds)].filter((id) => TASK_ID.test(id));
  if (!ids.length) return {};
  const response = await fetch(`/api/routine-history/latest?tasks=${encodeURIComponent(ids.join(","))}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Couldn't read routine runs (HTTP ${response.status})`);
  const body = await response.json() as { tasks?: unknown };
  if (!body || typeof body !== "object" || !body.tasks || typeof body.tasks !== "object" || Array.isArray(body.tasks)) throw new Error("Invalid routine runs");
  return body.tasks as Record<string, RoutineRunRef>;
}

const TASK_ID = /^[\w:%.-]{1,600}$/;

/** Every record the gateway holds. Failure is not fatal: ownership falls back to the project rules. */
export async function loadRoutineAlerts(): Promise<Record<string, RoutineRecord>> {
  const response = await fetch("/api/routine-alerts", { cache: "no-store" });
  if (!response.ok) throw new Error(`Couldn't read routine alerts (HTTP ${response.status})`);
  const body = await response.json() as { tasks?: unknown };
  if (!body || typeof body !== "object" || !body.tasks || typeof body.tasks !== "object" || Array.isArray(body.tasks)) throw new Error("Invalid routine alerts");
  return body.tasks as Record<string, RoutineRecord>;
}

export async function saveRoutineAlerts(taskId: string, patch: { bot?: string | null; alerts?: Partial<RoutineAlerts> }): Promise<RoutineRecord> {
  if (!TASK_ID.test(taskId)) throw new Error("Invalid routine");
  const response = await fetch(`/api/routine-alerts/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await response.json().catch(() => ({})) as { task?: RoutineRecord; error?: string };
  if (!response.ok || !body.task) throw new Error(body.error ?? `Couldn't save routine alerts (HTTP ${response.status})`);
  return body.task;
}
