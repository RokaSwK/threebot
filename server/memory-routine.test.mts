import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_ROUTINE_PROMPT, ensureMemoryRoutine, findMemoryRoutine, runMemoryRoutine, setMemoryRoutineEnabled, type MemoryRoutineTask } from "./memory-routine.mts";

function fakeClient(tasks: MemoryRoutineTask[]) {
  const calls: { tag: string; payload: any }[] = [];
  return {
    calls,
    stream(tag: string, _payload: unknown, onItem: (event: { tasks: MemoryRoutineTask[] }) => void) {
      calls.push({ tag, payload: null });
      queueMicrotask(() => onItem({ tasks }));
      return { cancel() {}, done: Promise.resolve() };
    },
    async call(tag: string, payload: any) {
      calls.push({ tag, payload });
      if (tag === "scheduledTasks.upsert") return { task: { id: payload.id ?? "task-1", ...payload } };
      if (tag === "scheduledTasks.delete") return { id: payload.id };
      if (tag === "scheduledTasks.runNow") return { task: tasks[0] };
      if (tag === "scheduledTasks.setEnabled") return { task: { ...tasks[0], enabled: payload.enabled } };
      return {};
    },
  } as any;
}

const bot = { slug: "alpha", name: "Alpha", projectId: "project-1", mainThreadId: "thread-1", model: { instanceId: "pi", model: "x" } } as any;
const modelSelection = { instanceId: "pi", model: "x" };
const task: MemoryRoutineTask = {
  id: "task-1", title: "Memory reflection", prompt: MEMORY_ROUTINE_PROMPT, enabled: true,
  threadId: "routine-thread", threadMode: "continue", schedule: { type: "fixed_time", timeOfDay: "03:30" },
  projectId: "project-1", modelSelection, runtimeMode: "full-access", interactionMode: "default",
  nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastRunError: null, runCount: 0,
};

test("creates the reflection routine with fresh sessions and the current payload", async () => {
  const client = fakeClient([]);
  const result = await ensureMemoryRoutine({ client, bot, modelSelection });
  assert.equal(result.created, true);
  const upsert = client.calls.find((call: { tag: string }) => call.tag === "scheduledTasks.upsert").payload;
  assert.equal(upsert.threadMode, "continue");
  assert.equal(upsert.threadId, null);
  assert.equal(upsert.projectId, "project-1");
  assert.equal(upsert.prompt, MEMORY_ROUTINE_PROMPT);
  assert.deepEqual(upsert.schedule, { type: "fixed_time", timeOfDay: "03:30" });
  assert.equal(upsert.createdBy, "agent");
});

test("updates the existing routine instead of creating a duplicate", async () => {
  const client = fakeClient([task]);
  const result = await ensureMemoryRoutine({ client, bot, modelSelection, enabled: false });
  assert.equal(result.created, false);
  const upsert = client.calls.find((call: { tag: string }) => call.tag === "scheduledTasks.upsert").payload;
  assert.equal(upsert.id, "task-1");
  assert.equal(upsert.requireExisting, true);
  assert.equal(upsert.enabled, false);
  assert.equal((await findMemoryRoutine(client, bot))?.id, "task-1");
});

test("auto-ensure keeps a disabled routine disabled", async () => {
  const client = fakeClient([{ ...task, enabled: false }]);
  await ensureMemoryRoutine({ client, bot, modelSelection });
  const upsert = client.calls.find((call: { tag: string }) => call.tag === "scheduledTasks.upsert").payload;
  assert.equal(upsert.enabled, false);
});

test("finds and renames a legacy reflection routine", async () => {
  const legacy = { ...task, title: "Memory reflection" };
  const client = fakeClient([legacy]);
  const result = await ensureMemoryRoutine({ client, bot, modelSelection });
  assert.equal(result.created, false);
  const upsert = client.calls.find((call: { tag: string }) => call.tag === "scheduledTasks.upsert").payload;
  assert.equal(upsert.id, "task-1");
  assert.equal(upsert.title, "Memory maintenance");
});

test("runs and toggles the existing routine", async () => {
  const client = fakeClient([task]);
  assert.equal((await runMemoryRoutine(client, bot)).id, "task-1");
  assert.equal(client.calls.at(-1).tag, "scheduledTasks.runNow");
  assert.equal((await setMemoryRoutineEnabled(client, bot, false)).id, "task-1");
  assert.equal(client.calls.at(-1).payload.enabled, false);
});

test("rebinds a legacy main-thread routine to a dedicated routine thread", async () => {
  const legacy = { ...task, threadId: "thread-1", modelSelection: { instanceId: "antigravity", model: "expensive" } };
  const client = fakeClient([legacy]);
  const result = await ensureMemoryRoutine({ client, bot, modelSelection });
  assert.equal(result.created, true);
  assert.ok(client.calls.some((call: { tag: string }) => call.tag === "scheduledTasks.delete"));
  const upsert = client.calls.find((call: { tag: string }) => call.tag === "scheduledTasks.upsert").payload;
  assert.equal(upsert.id, undefined);
  assert.equal(upsert.threadId, null);
  assert.deepEqual(upsert.modelSelection, modelSelection);
});
