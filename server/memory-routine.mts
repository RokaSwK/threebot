// Create, run and disable the T3 routine that performs a memory maintenance pass. T3 owns routines;
// Threebot only uses its existing RPC. No T3 schema or source change.
import { randomUUID } from "node:crypto";
import type { Bot } from "./main-bot.mts";
import type { T3Client } from "./t3rpc.mts";

export const MEMORY_ROUTINE_TITLE = "Memory maintenance";
const LEGACY_MEMORY_ROUTINE_TITLE = "Memory reflection";
export const MEMORY_ROUTINE_PROMPT = `Run a memory maintenance pass now. Work only through the memory tools; do not answer in chat.
1. Call memory_reflect, read the packet, then propose at most 10 add/replace/supersede operations to memory_reflect_apply with the exact sourceMessageId and sourceQuote. If there are no new owner messages, apply an empty batch to advance the bookmark.
2. Call memory_defrag with op audit and read the proposed plan.
3. Call memory_defrag with op safe-dedupe to remove byte-identical duplicate fact lines.
4. Call memory_defrag with op retire-closed to move facts whose explicit validity ended into memory/notes/history.
5. Review the remaining plan findings. If a note is over budget and has at least two \`##\` headings, read it and split it with \`memory_note_split\`. If two notes clearly cover the same topic, read both and merge them with \`memory_note_merge\`. You may add or update a note when an exact owner quote supports it; otherwise leave the finding as proposed and report it. Never delete a unique fact or note, merge undated contradictions, or invent a source.`;

export type MemoryRoutineSchedule = { type: "fixed_time"; timeOfDay: string; weekdays?: number[] } | { type: "interval"; everyMs: number };
export type MemoryRoutineTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  threadId: string | null;
  threadMode?: string;
  schedule: MemoryRoutineSchedule;
  projectId: string;
  modelSelection: unknown;
  runtimeMode: string;
  interactionMode: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  runCount: number;
};

type RpcTask = Partial<MemoryRoutineTask> & { id?: string; [key: string]: unknown };

/** T3 exposes routines as a subscription, not a list RPC. Take the first snapshot and cancel it. */
export async function listScheduledTasks(client: T3Client, timeoutMs = 5_000): Promise<MemoryRoutineTask[]> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, tasks?: MemoryRoutineTask[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.cancel();
      if (error) reject(error);
      else resolve(tasks ?? []);
    };
    const stream = client.stream("scheduledTasks.subscribe", {}, (event: { tasks?: RpcTask[] }) => {
      if (Array.isArray(event.tasks)) finish(null, event.tasks.filter((task): task is MemoryRoutineTask => typeof task?.id === "string"));
    });
    const timer = setTimeout(() => finish(new Error("T3 did not send the routine list in time.")), timeoutMs);
    stream.done.catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export async function findMemoryRoutine(client: T3Client, bot: Bot): Promise<MemoryRoutineTask | null> {
  const tasks = await listScheduledTasks(client);
  return tasks.find((task) => (task.title === MEMORY_ROUTINE_TITLE || task.title === LEGACY_MEMORY_ROUTINE_TITLE) && task.projectId === bot.projectId) ?? null;
}

export function defaultMemorySchedule(): MemoryRoutineSchedule {
  return { type: "fixed_time", timeOfDay: "03:30" };
}

const inFlightEnsure = new Map<string, Promise<{ task: MemoryRoutineTask; created: boolean }>>();

export async function ensureMemoryRoutine({
  client,
  bot,
  modelSelection,
  schedule = defaultMemorySchedule(),
  enabled,
}: {
  client: T3Client;
  bot: Bot;
  modelSelection: unknown;
  schedule?: MemoryRoutineSchedule;
  /** Omitted preserves an existing routine's enabled state; new routines default to enabled. */
  enabled?: boolean;
}): Promise<{ task: MemoryRoutineTask; created: boolean }> {
  if (!bot.projectId || !bot.mainThreadId) throw new Error("This Bot needs a project and main thread before it can have a memory maintenance routine.");
  if (!modelSelection) throw new Error("Pick a model for memory maintenance.");
  const key = `${bot.projectId}:${bot.slug}`;
  const running = inFlightEnsure.get(key);
  if (running) return running;

  const promise = (async () => {
    let existing = await findMemoryRoutine(client, bot);
    const nextEnabled = enabled ?? existing?.enabled ?? true;
    const modelChanged = existing ? JSON.stringify(existing.modelSelection) !== JSON.stringify(modelSelection) : false;
    const boundToChat = existing ? existing.threadId === bot.mainThreadId : false;
    if (existing && (modelChanged || boundToChat)) {
      await client.call("scheduledTasks.delete", { id: existing.id });
      existing = null;
    }
    const response = await client.call("scheduledTasks.upsert", {
      ...(existing ? { id: existing.id, requireExisting: true } : {}),
      commandId: randomUUID(),
      title: MEMORY_ROUTINE_TITLE,
      prompt: MEMORY_ROUTINE_PROMPT,
      enabled: nextEnabled,
      schedule,
      projectId: bot.projectId,
      // A bound thread keeps its own provider/model; T3 ignores task.modelSelection for it.
      // A dedicated thread launched by the task uses the routine model, then stays bound for later runs.
      threadId: null,
      threadMode: "continue",
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "server",
    });
    const task = response?.task as RpcTask | undefined;
    if (!task || typeof task.id !== "string") throw new Error("T3 did not return the saved routine.");
    return { task: task as MemoryRoutineTask, created: !existing };
  })();

  inFlightEnsure.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightEnsure.delete(key);
  }
}

export async function runMemoryRoutine(client: T3Client, bot: Bot): Promise<MemoryRoutineTask> {
  const existing = await findMemoryRoutine(client, bot);
  if (!existing) throw new Error("This Bot has no memory reflection routine yet.");
  const response = await client.call("scheduledTasks.runNow", { id: existing.id });
  const task = response?.task as RpcTask | undefined;
  if (!task || typeof task.id !== "string") throw new Error("T3 did not confirm the run.");
  return task as MemoryRoutineTask;
}

export async function setMemoryRoutineEnabled(client: T3Client, bot: Bot, enabled: boolean): Promise<MemoryRoutineTask> {
  const existing = await findMemoryRoutine(client, bot);
  if (!existing) throw new Error("This Bot has no memory reflection routine yet.");
  const response = await client.call("scheduledTasks.setEnabled", { id: existing.id, enabled });
  const task = response?.task as RpcTask | undefined;
  if (!task || typeof task.id !== "string") throw new Error("T3 did not confirm the change.");
  return task as MemoryRoutineTask;
}
