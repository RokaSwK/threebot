import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

// `roomDelegation` reads the shared pure rules in `server/room-lines.mts`, so bundle it the way the
// other room tests do instead of asking Node to resolve the app's module graph.
const source = fileURLToPath(new URL("../src/lib/roomDelegation.ts", import.meta.url));
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "room-delegation-test",
    resolveId: (id) => id.endsWith("virtual:room-delegation-tests") ? "\0room-delegation-tests" : undefined,
    load: (id) => id === "\0room-delegation-tests" ? `export { delegatedRows, roomLines } from ${JSON.stringify(source)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:room-delegation-tests", write: false },
});
const entry = entryChunk(bundle);
const directory = await mkdtemp(join(tmpdir(), "bot-room-delegation-"));
const filename = join(directory, "room-delegation.mjs");
await writeFile(filename, entry.code);
const { delegatedRows, roomLines } = await import(pathToFileURL(filename).href) as {
  delegatedRows: (...args: any[]) => any[];
  roomLines: (...args: any[]) => any[];
};
after(() => rm(directory, { recursive: true, force: true }));

const member = (slug: string, threadId: string | null) => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), label: "", color: "blue", shape: "sphere",
  avatarImage: null, threadId, status: "ready" as const, model: null, runtimeMode: "inherit", lastTurnAt: null,
});

const turn = (runs: any[]) => ({ id: "turn-1", at: "2026-01-01T00:00:00.000Z", text: "audita", mentions: [], replyTo: null, status: "done", runs });
const run = (id: string, status: string, completedAt: string | null = null) => ({
  id, ordinal: 1, status, requestedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z",
  completedAt, modelSelection: null,
});
const assistant = (id: string, runId: string, text: string, at = "2026-01-01T00:00:05.000Z") => ({
  id, threadId: "thread-a", runId, ordinal: 1, status: "completed", type: "assistant_message",
  title: null, startedAt: null, completedAt: at, updatedAt: at, parentItemId: null, text,
});
const child = (status: string, at: string | null) => ({
  id: "sub:child-a", threadId: "thread-a", runId: "run-1", ordinal: 2, status, type: "subagent",
  title: "Assessment A", childThreadId: "child-a", subagentId: "sub-a",
  startedAt: "2026-01-01T00:00:02.000Z", completedAt: at, updatedAt: at ?? "2026-01-01T00:00:02.000Z", parentItemId: null,
});
const notification = (runId: string) => ({
  id: `note:${runId}`, threadId: "thread-a", runId, ordinal: 3, status: "completed", type: "notification",
  title: null, startedAt: null, completedAt: "2026-01-01T00:00:30.000Z", updatedAt: "2026-01-01T00:00:30.000Z",
  parentItemId: null, source: { kind: "delegated_task", childThreadId: "child-a" },
});
const agent = (status: string) => ({
  id: "sub-a", title: "Assessment A", status, childThreadId: "child-a", result: null,
  driver: "antigravity", providerInstanceId: "antigravity", model: "gemini-4-argon",
  startedAt: "2026-01-01T00:00:02.000Z", completedAt: status === "running" ? null : "2026-01-01T00:00:30.000Z",
  updatedAt: "2026-01-01T00:00:30.000Z",
});

const members = [member("alpha", "thread-a"), member("beta", "thread-b")];
const runs = { "run-1": run("run-1", "completed", "2026-01-01T00:00:05.000Z"), "run-2": run("run-2", "completed", "2026-01-01T00:00:31.000Z") };
const turns = [turn([{ slug: "alpha", runId: "run-1", replyRunId: "run-2", at: "2026-01-01T00:00:05.000Z", status: "replied", late: false }])];
const settledThread = {
  "thread-a": {
    items: {
      ack: assistant("ack", "run-1", "En marcha"),
      child: child("completed", "2026-01-01T00:00:29.000Z"),
      note: notification("run-2"),
      report: assistant("report", "run-2", "Informe final", "2026-01-01T00:00:31.000Z"),
    },
    runs,
    subagents: { "sub-a": agent("completed") },
  },
};

test("roomLines withholds the progress note while the member is still working", () => {
  const threadData = {
    "thread-a": {
      items: { ack: assistant("ack", "run-1", "En marcha"), child: child("running", null) },
      runs: { "run-1": run("run-1", "completed") },
      subagents: { "sub-a": agent("running") },
    },
  };
  // The room has not closed this member's part yet: no status on the turn's run.
  const openTurns = [{ ...turn([{ slug: "alpha", runId: "run-1", at: "2026-01-01T00:00:05.000Z" }]), status: "running" }];
  assert.deepEqual(roomLines(members, openTurns, threadData), []);
});

test("roomLines renders a closed run even when the browser never saw the wake-up run", () => {
  // The room says the part is done; the live view may only hold the dispatch run (a wake-up run's
  // events can be missed). The line must still come from the chain's items.
  const threadData = {
    "thread-a": {
      items: settledThread["thread-a"].items,
      runs: { "run-1": run("run-1", "completed", "2026-01-01T00:00:05.000Z") },
      subagents: { "sub-a": agent("completed") },
    },
  };
  const lines = roomLines(members, turns, threadData);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Informe final");
});

test("roomLines reads the line through the wake-up run once the child finished", () => {
  const lines = roomLines(members, turns, settledThread);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Informe final");
  assert.equal(lines[0].runId, "run-1", "the room's run id, not the wake-up run");
  assert.equal(lines[0].pass, false);
  // A wake-up that passes never promotes the acknowledgement.
  const passing = {
    "thread-a": {
      items: { ack: assistant("ack", "run-1", "En marcha"), child: child("completed", "2026-01-01T00:00:29.000Z"), note: notification("run-2"), report: assistant("report", "run-2", "(pass)") },
      runs,
      subagents: { "sub-a": agent("completed") },
    },
  };
  assert.equal(roomLines(members, turns, passing)[0].text, "(pass)");
});

test("delegatedRows keeps the tasks with their harness and model, after the line", () => {
  const rows = delegatedRows(members, turns, settledThread);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member.slug, "alpha");
  assert.equal(rows[0].tasks.length, 1);
  assert.equal(rows[0].tasks[0].title, "Assessment A");
  assert.equal(rows[0].tasks[0].driver, "antigravity");
  assert.equal(rows[0].tasks[0].model, "gemini-4-argon");
  assert.equal(rows[0].at, "2026-01-01T00:00:31.000Z", "the card sits after the member's line");
  // A member with no thread, or a run with no delegation, adds nothing.
  assert.deepEqual(delegatedRows(members, turns, {}), []);
  const plain = { "thread-a": { items: { ack: assistant("ack", "run-1", "Hola") }, runs, subagents: {} } };
  assert.deepEqual(delegatedRows(members, turns, plain), []);
});

test("a timed-out room part displays only a settled late report", () => {
  const timedOut = [turn([{ slug: "alpha", runId: "run-1", status: "timeout", late: true }])];
  const projection = settledThread["thread-a"];
  const pending = {
    "thread-a": {
      ...projection,
      items: { ack: projection.items.ack, child: child("running", null) },
    },
  };
  assert.deepEqual(roomLines(members, timedOut, pending), []);
  const lines = roomLines(members, timedOut, settledThread);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Informe final");
  assert.equal(lines[0].late, true);
});

test("a published reply waits for its exact item when a device only has the acknowledgement", () => {
  const data = {
    "thread-a": {
      items: { ack: assistant("ack", "run-1", "En marcha") },
      runs,
    },
  };
  const published = [turn([{ slug: "alpha", runId: "run-1", replyItemId: "final", status: "replied" }])];
  assert.deepEqual(roomLines(members, published, data), []);
  const complete = { "thread-a": { ...data["thread-a"], items: {
    ack: data["thread-a"].items.ack,
    final: assistant("final", "run-1", "Informe"),
  } } };
  assert.equal(roomLines(members, published, complete)[0].text, "Informe");
});
