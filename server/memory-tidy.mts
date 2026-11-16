// The optional routine that keeps a Bot's memory file tidy. T3 owns scheduled tasks; this module
// only writes one through the existing RPC, with a dedicated conversation so a run never touches
// the Bot's chat or re-reads it.
import { randomUUID } from "node:crypto";
import type { Bot } from "./main-bot.mts";
import { MEMORY_LIMITS } from "./memory.mts";
import type { T3Client } from "./t3rpc.mts";

/** Only the two RPC calls this module needs, so a fake client is a fake client. */
type RoutineClient = Pick<T3Client, "stream" | "call">;

export const MEMORY_TIDY_TITLE = "Tidy memory";

export const MEMORY_TIDY_PROMPT = `Tidy your memory now. Work only inside your \`memory/\` folder and answer with one short paragraph.

1. Read \`memory/MEMORY.md\` and \`memory/log.md\`.
2. Keep \`MEMORY.md\` inside the snapshot budget: ${MEMORY_LIMITS.snapshotBotLines} lines and ${MEMORY_LIMITS.snapshotBotChars.toLocaleString("en-US")} characters. The gateway copies only that much into a fresh session, so anything past it is invisible. Count by reading the file; do not run shell commands.
3. Merge repeated facts into one short line under its heading. When two lines disagree, keep the newest and delete the older. Move dated diary entries to \`memory/log.md\`.
4. Remove only what you can prove is stale, superseded or contradicted by a newer line. Never delete a unique fact you cannot verify; list it instead.
5. Leave the user's own wording alone when it is already a clear fact.
6. Report the final line and character count, what you merged, removed or moved, and anything you left for the user to decide. If nothing changed, say so in one line.`;

export type MemoryTidyFrequency = "off" | "weekly" | "nightly";

export type MemoryTidyTask = {
  id: string;
  title: string;
  enabled: boolean;
  threadId: string | null;
  threadMode?: string;
  schedule: { type: string; timeOfDay?: string; weekdays?: number[]; [key: string]: unknown };
  projectId: string;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  lastRunError?: string | null;
};

type RpcTask = Partial<MemoryTidyTask> & { id?: string; [key: string]: unknown };

/** T3 exposes routines as a subscription, not a list RPC. Take the first snapshot and cancel it. */
export async function listScheduledTasks(client: RoutineClient, timeoutMs = 5_000): Promise<MemoryTidyTask[]> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let stream: { cancel: () => void; done: Promise<unknown> } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, tasks?: MemoryTidyTask[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream?.cancel();
      if (error) reject(error);
      else resolve(tasks ?? []);
    };
    stream = client.stream("scheduledTasks.subscribe", {}, (event: { tasks?: RpcTask[] }) => {
      if (!Array.isArray(event?.tasks)) return;
      finish(null, event.tasks.filter((task): task is MemoryTidyTask => typeof task?.id === "string"));
    });
    timer = setTimeout(() => finish(new Error("T3 did not send the routine list in time.")), timeoutMs);
    stream.done.catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** The linked routine first; then a title match, for a Bot from before the link was stored. */
export async function findMemoryTidy(client: RoutineClient, bot: Bot): Promise<MemoryTidyTask | null> {
  const tasks = await listScheduledTasks(client);
  const linked = typeof bot.memoryTidyRoutineId === "string" ? bot.memoryTidyRoutineId : null;
  return tasks.find((task) => task.id === linked)
    ?? tasks.find((task) => task.title === MEMORY_TIDY_TITLE && task.projectId === bot.projectId)
    ?? null;
}

export function memoryTidySchedule(frequency: Exclude<MemoryTidyFrequency, "off">): { type: "fixed_time"; timeOfDay: string; weekdays?: number[] } {
  return { type: "fixed_time", timeOfDay: "03:30", ...(frequency === "weekly" ? { weekdays: [1] } : {}) };
}

/**
 * Off pauses the routine and keeps it, so the chosen time survives. Weekly and nightly create it
 * once and then edit that same task; a bound routine keeps its conversation across edits.
 */
export async function setMemoryTidy({ client, bot, frequency, modelSelection }: {
  client: RoutineClient;
  bot: Bot;
  frequency: MemoryTidyFrequency;
  modelSelection: unknown;
}): Promise<{ task: MemoryTidyTask | null; created: boolean }> {
  const existing = await findMemoryTidy(client, bot);
  if (frequency === "off") {
    if (!existing) return { task: null, created: false };
    const response = await client.call("scheduledTasks.setEnabled", { id: existing.id, enabled: false });
    return { task: (response?.task ?? existing) as MemoryTidyTask, created: false };
  }
  if (!modelSelection) throw new Error("Pick a model for this Bot first.");
  const response = await client.call("scheduledTasks.upsert", {
    ...(existing ? { id: existing.id, requireExisting: true } : {}),
    commandId: randomUUID(),
    title: MEMORY_TIDY_TITLE,
    prompt: MEMORY_TIDY_PROMPT,
    enabled: true,
    schedule: memoryTidySchedule(frequency),
    projectId: bot.projectId,
    // The first run launches the dedicated thread; fresh_session starts later runs in a new
    // provider session there, so the routine never grows a context and never reads the Bot's chat.
    threadId: existing?.threadId ?? null,
    threadMode: existing?.threadMode ?? "fresh_session",
    workspaceStrategy: { type: "root" },
    modelSelection,
    // It only edits files inside memory/. Commands still ask; no need for full access.
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
  });
  const task = response?.task as RpcTask | undefined;
  if (!task || typeof task.id !== "string") throw new Error("T3 did not return the saved routine.");
  return { task: task as MemoryTidyTask, created: !existing };
}
