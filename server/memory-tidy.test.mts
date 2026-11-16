import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryTidyPrompt, MEMORY_TIDY_PROMPT, MEMORY_TIDY_TITLE, findMemoryTidy, listScheduledTasks, memoryTidySchedule, setMemoryTidy, type MemoryTidyTask } from "./memory-tidy.mts";

function fakeClient(tasks: MemoryTidyTask[]) {
  const calls: { tag: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    stream(tag: string, _payload: unknown, onItem: (event: { tasks: MemoryTidyTask[] }) => void) {
      calls.push({ tag, payload: {} });
      queueMicrotask(() => onItem({ tasks }));
      return { cancel() {}, done: Promise.resolve() };
    },
    async call(tag: string, payload: any) {
      calls.push({ tag, payload });
      if (tag === "scheduledTasks.upsert") return { task: { ...payload, id: payload.id ?? "task-1", title: MEMORY_TIDY_TITLE, projectId: "project-1", threadId: payload.threadId ?? null } };
      if (tag === "scheduledTasks.setEnabled") return { task: { ...tasks[0], enabled: payload.enabled } };
      return {};
    },
  };
}

const bot = { slug: "alpha", name: "Alpha", projectId: "project-1", mainThreadId: "thread-1", dataDir: "/tmp", workspaceRoot: "/tmp" } as any;
const modelSelection = { instanceId: "pi", model: "cheap" };
const task: MemoryTidyTask = {
  id: "task-1", title: MEMORY_TIDY_TITLE, enabled: true, threadId: "routine-thread", threadMode: "fresh_session",
  schedule: { type: "fixed_time", timeOfDay: "03:30" }, projectId: "project-1", lastRunAt: null, lastRunStatus: null, lastRunError: null,
};

test("the prompt uses the current memory model and its snapshot budget", () => {
  assert.match(MEMORY_TIDY_PROMPT, /200 lines/u);
  assert.match(MEMORY_TIDY_PROMPT, /8,000 characters/u);
  assert.match(MEMORY_TIDY_PROMPT, /memory\/log\.md/u);
  assert.doesNotMatch(MEMORY_TIDY_PROMPT, /memory\/notes|memory_/u);
  assert.match(MEMORY_TIDY_PROMPT, /one short paragraph/u);
});

test("nightly and weekly schedules use the server clock and Monday for weekly", () => {
  assert.deepEqual(memoryTidySchedule("nightly"), { type: "fixed_time", timeOfDay: "03:30" });
  assert.deepEqual(memoryTidySchedule("weekly"), { type: "fixed_time", timeOfDay: "03:30", weekdays: [1] });
});

test("creating the routine uses a dedicated fresh-session thread and auto-accept edits", async () => {
  const client = fakeClient([]);
  const result = await setMemoryTidy({ client, bot, frequency: "nightly", modelSelection });
  assert.equal(result.created, true);
  const upsert = client.calls.find((call) => call.tag === "scheduledTasks.upsert")!.payload;
  assert.equal(upsert.threadId, null);
  assert.equal(upsert.threadMode, "fresh_session");
  assert.equal(upsert.runtimeMode, "auto-accept-edits");
  assert.equal(upsert.enabled, true);
  assert.equal(upsert.title, MEMORY_TIDY_TITLE);
  assert.equal(upsert.prompt, MEMORY_TIDY_PROMPT);
  assert.deepEqual(upsert.schedule, { type: "fixed_time", timeOfDay: "03:30" });
  assert.deepEqual(upsert.modelSelection, modelSelection);
  assert.equal(upsert.createdBy, "user");
});

test("editing the frequency keeps the same task and its bound conversation", async () => {
  const client = fakeClient([task]);
  const result = await setMemoryTidy({ client, bot, frequency: "weekly", modelSelection });
  assert.equal(result.created, false);
  const upsert = client.calls.find((call) => call.tag === "scheduledTasks.upsert")!.payload;
  assert.equal(upsert.id, "task-1");
  assert.equal(upsert.requireExisting, true);
  assert.equal(upsert.threadId, "routine-thread");
  assert.equal(upsert.threadMode, "fresh_session");
  assert.deepEqual(upsert.schedule, { type: "fixed_time", timeOfDay: "03:30", weekdays: [1] });
});

test("off pauses the routine and keeps it", async () => {
  const client = fakeClient([task]);
  const result = await setMemoryTidy({ client, bot, frequency: "off", modelSelection });
  assert.equal(result.created, false);
  assert.equal((result.task as MemoryTidyTask).enabled, false);
  assert.ok(!client.calls.some((call) => call.tag === "scheduledTasks.upsert"));
  assert.deepEqual(client.calls.find((call) => call.tag === "scheduledTasks.setEnabled")!.payload, { id: "task-1", enabled: false });
});

test("off with no routine creates nothing", async () => {
  const client = fakeClient([]);
  assert.deepEqual(await setMemoryTidy({ client, bot, frequency: "off", modelSelection }), { task: null, created: false });
  assert.ok(!client.calls.some((call) => call.tag === "scheduledTasks.upsert" || call.tag === "scheduledTasks.setEnabled"));
});

test("a linked id wins over the title, and a legacy title still links", async () => {
  const renamed = { ...task, title: "Nightly cleanup" };
  assert.equal((await findMemoryTidy(fakeClient([renamed]), { ...bot, memoryTidyRoutineId: "task-1" }))?.id, "task-1");
  assert.equal((await findMemoryTidy(fakeClient([task]), bot))?.id, "task-1");
  assert.equal(await findMemoryTidy(fakeClient([{ ...task, projectId: "other" }]), bot), null);
});

test("the routine list waits for the first snapshot", async () => {
  const client = fakeClient([task]);
  assert.deepEqual(await listScheduledTasks(client), [task]);
});


test("adopted Bot tidy targets only its .bot/memory folder", async () => {
  const adopted = { ...bot, adopted: true };
  const prompt = memoryTidyPrompt(adopted);
  assert.match(prompt, /`\.bot\/memory\/` folder/);
  assert.match(prompt, /`\.bot\/memory\/MEMORY.md`/);
  assert.match(prompt, /`\.bot\/memory\/log.md`/);
  assert.doesNotMatch(prompt, /`memory\//);
  const client = fakeClient([]);
  await setMemoryTidy({ client, bot: adopted, frequency: "nightly", modelSelection });
  assert.equal(client.calls.find((call) => call.tag === "scheduledTasks.upsert")!.payload.prompt, prompt);
});
