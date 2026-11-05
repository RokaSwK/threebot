import assert from "node:assert/strict";
import { build } from "vite";
import { beforeEach, mock, test } from "node:test";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "side-chats-test-entry",
    resolveId: (id) => id.endsWith("virtual:side-chats-test") ? "\0side-chats-test" : undefined,
    load: (id) => id === "\0side-chats-test"
      ? `export * from ${JSON.stringify(`${src}lib/sideChats.ts`)};
         export { modelSwitches } from ${JSON.stringify(`${src}lib/transcript.ts`)};
         export { isProjectEnrichment } from ${JSON.stringify(`${src}lib/threadFamily.ts`)};
         export { queuedSender } from ${JSON.stringify(`${src}lib/runtimeApi.ts`)};
         export { bringBackSideChat, closeSideChat, saveFallbackModel, startSideChat, toast, useApp } from ${JSON.stringify(`${src}store.ts`)};
         export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};`
      : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:side-chats-test", write: false },
});
const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
assert.ok(entry, "test bundle has an entry point");
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window ??= { setTimeout, clearTimeout };
const app = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);
const { bringBackRun, canStartSideChat, closeSideChat, isProjectEnrichment, modelSwitches, parseSideCommand, queuedSender, saveFallbackModel, sideChatSignal, sideChatTitle, sideChatsOf, startSideChat, t3, threadBusy, useApp } = app;

const thread = (patch = {}) => ({ id: "t", title: "Side", status: "idle", activeRunId: null, pendingRuntimeRequest: null, archivedAt: null, updatedAt: "2026-11-02T10:00:00Z", lastVisitedAt: null, latestRunCompletedAt: null, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" }, ...patch });
const side = (patch = {}) => thread({ lineage: { parentThreadId: "main", relationshipToParent: "fork", rootThreadId: "main", sideChat: true }, ...patch });

beforeEach(() => {
  mock.restoreAll();
  useApp.setState({ runtimeFeatures: { sideChats: true }, threads: { main: thread({ id: "main" }) }, bots: { roka: { slug: "roka", mainThreadId: "main" } }, sideChat: null });
});

test("/side and /btw open a side chat, and nothing else does", () => {
  assert.deepEqual(parseSideCommand("/btw why clamp?"), { prompt: "why clamp?" });
  assert.deepEqual(parseSideCommand("  /SIDE\nfirst\nsecond "), { prompt: "first\nsecond" });
  assert.deepEqual(parseSideCommand("/side"), { prompt: "" });
  assert.equal(parseSideCommand("/sidebar"), null);
  assert.equal(parseSideCommand("by the way /btw"), null);
});

test("only a local top-level conversation can start one", () => {
  assert.equal(canStartSideChat(thread()), true);
  assert.equal(canStartSideChat(side()), false);
  assert.equal(canStartSideChat(thread({ lineage: { relationshipToParent: "subagent" } })), false);
  assert.equal(canStartSideChat(thread({ environmentId: "laptop" })), false);
  assert.equal(canStartSideChat(undefined), false);
});

test("listing skips other parents and archived side chats", () => {
  const threads = { a: side({ id: "a", updatedAt: "2026-11-01T00:00:00Z" }), b: side({ id: "b", updatedAt: "2026-11-02T00:00:00Z" }), c: side({ id: "c", archivedAt: "2026-11-02T00:00:00Z" }), d: thread({ id: "d", lineage: { parentThreadId: "main", relationshipToParent: "subagent" } }) };
  assert.deepEqual(sideChatsOf(threads, "main").map((chat) => chat.id), ["b", "a"]);
  assert.deepEqual(sideChatsOf(threads, "other"), []);
});

test("titles come from the question and stay short", () => {
  assert.equal(sideChatTitle(""), "Side chat");
  assert.equal(sideChatTitle("  why\nmore"), "why");
  assert.ok(sideChatTitle("x".repeat(80)).length <= 48);
});

test("bring back uses the newest finished reply unless a newer run is going", () => {
  assert.equal(bringBackRun([]), null);
  assert.equal(bringBackRun([{ id: "a", ordinal: 1, status: "running" }]), null);
  assert.equal(bringBackRun([{ id: "a", ordinal: 1, status: "completed" }, { id: "b", ordinal: 2, status: "waiting" }]).id, "b");
  assert.equal(bringBackRun([{ id: "a", ordinal: 1, status: "completed" }, { id: "b", ordinal: 2, status: "running" }]), null);
  assert.equal(bringBackRun([{ id: "a", ordinal: 1, status: "completed" }, { id: "b", ordinal: 2, status: "failed" }]).id, "a");
});

test("the pill speaks only when a side chat has something to say", () => {
  assert.equal(sideChatSignal(side({ pendingRuntimeRequest: { id: "r" } })), "Needs you");
  assert.equal(sideChatSignal(side({ status: "running" })), "Working");
  assert.equal(sideChatSignal(side({ latestRunCompletedAt: "2026-11-02T10:00:00Z" })), "Replied");
  assert.equal(sideChatSignal(side({ latestRunCompletedAt: "2026-11-02T10:00:00Z", lastVisitedAt: "2026-11-02T10:01:00Z" })), null);
  assert.equal(threadBusy(thread({ status: "completed", activityRunStatus: "running" })), true);
});

test("starting forks hidden, asks there, then opens beside the parent", async () => {
  const sent = [];
  mock.method(t3, "dispatch", async (command) => {
    sent.push(command);
    if (command.type === "thread.fork") useApp.setState((s) => ({ threads: { ...s.threads, [command.targetThreadId]: side({ id: command.targetThreadId }) } }));
    return { sequence: 1 };
  });
  assert.equal(await startSideChat({ slug: "roka" }, "main", "why clamp?"), true);
  const [fork, message] = sent;
  assert.equal(fork.type, "thread.fork");
  assert.equal(fork.sideChat, true);
  assert.equal(fork.sourceThreadId, "main");
  assert.deepEqual(fork.sourcePoint, { type: "latest_stable" });
  assert.equal(fork.title, "why clamp?");
  assert.equal(message.type, "message.dispatch");
  assert.equal(message.threadId, fork.targetThreadId);
  assert.equal(message.text, "why clamp?");
  assert.deepEqual(useApp.getState().sideChat, { parentThreadId: "main", threadId: fork.targetThreadId });
});

test("a failed first message takes the empty fork back", async () => {
  const sent = [];
  mock.method(t3, "dispatch", async (command) => {
    sent.push(command);
    if (command.type === "thread.fork") useApp.setState((s) => ({ threads: { ...s.threads, [command.targetThreadId]: side({ id: command.targetThreadId }) } }));
    if (command.type === "message.dispatch") throw new Error("nope");
    return { sequence: 1 };
  });
  assert.equal(await startSideChat({ slug: "roka" }, "main", "hi"), false);
  await new Promise((resolve) => setImmediate(resolve));
  const removal = sent.find((command) => command.type === "thread.delete");
  assert.equal(removal.onlyIfUnused, true);
  assert.equal(removal.threadId, sent[0].targetThreadId);
  assert.equal(useApp.getState().sideChat, null);
});

test("an old server never gets a fork", async () => {
  useApp.setState({ runtimeFeatures: { sideChats: false } });
  const dispatch = mock.method(t3, "dispatch", async () => ({ sequence: 1 }));
  assert.equal(await startSideChat({ slug: "roka" }, "main"), false);
  assert.equal(dispatch.mock.callCount(), 0);
});

test("closing only ever removes an unused side chat", async () => {
  const sent = [];
  mock.method(t3, "dispatch", async (command) => { sent.push(command); return { sequence: 1 }; });
  useApp.setState((s) => ({ threads: { ...s.threads, x: side({ id: "x" }) }, sideChat: { parentThreadId: "main", threadId: "x" } }));
  closeSideChat();
  assert.equal(useApp.getState().sideChat, null);
  assert.deepEqual(sent.filter((command) => command.type === "thread.delete").map((command) => command.onlyIfUnused), [true]);
});

test("T3's project-only snapshot never replaces the thread roster", () => {
  const roots = ["/repo"];
  assert.equal(isProjectEnrichment({ resolvedRepositoryIdentityRoots: roots, snapshot: { threads: [], archivedThreads: [] } }), true);
  assert.equal(isProjectEnrichment({ snapshot: { threads: [], archivedThreads: [] } }), false);
  assert.equal(isProjectEnrichment({ resolvedRepositoryIdentityRoots: roots, snapshot: { threads: [{}], archivedThreads: [] } }), false);
  assert.equal(isProjectEnrichment({ resolvedRepositoryIdentityRoots: roots, snapshot: { threads: [], archivedThreads: [{}] } }), false);
});

test("the backup model is T3's own setting", async () => {
  const call = mock.method(t3, "call", async (_tag, { patch }) => patch);
  const selection = { instanceId: "codex", model: "gpt" };
  await saveFallbackModel(selection);
  assert.equal(call.mock.calls[0].arguments[0], "server.updateSettings");
  assert.deepEqual(useApp.getState().fallbackModel, selection);
  await saveFallbackModel(null);
  assert.equal(useApp.getState().fallbackModel, null);
});

test("dividers show only what changed, above the first message that used it", () => {
  const selection = (model, effort) => ({ instanceId: "claude", model, options: effort ? [{ id: "effort", value: effort }] : undefined });
  const run = (ordinal, modelSelection, status = "completed") => ({ id: `r${ordinal}`, ordinal, status, userMessageId: `m${ordinal}`, modelSelection });
  const name = ({ model }) => model.toUpperCase();
  const switches = modelSwitches([
    run(3, selection("opus", "high")),
    run(1, selection("opus", "low")),
    run(2, selection("opus", "low")),
    run(4, selection("sonnet", "high")),
    run(5, selection("haiku", "medium")),
    run(6, selection("haiku")),
    run(7, selection("opus", "xhigh"), "queued"),
  ], name);
  assert.deepEqual([...switches], [["m3", "Low → High"], ["m4", "OPUS → SONNET"], ["m5", "SONNET High → HAIKU Medium"]]);
});

test("queued messages say who sent them, and yours stay plain", () => {
  const names = { routine: (id) => ({ t1: "Morning triage" })[id], thread: (id) => ({ b1: "Roka" })[id] };
  const message = (patch) => ({ id: "m", text: "hello", attachments: [], ...patch });
  assert.equal(queuedSender(message({ createdBy: "user" }), names), null);
  assert.equal(queuedSender(null, names), null);
  assert.deepEqual(queuedSender(message({ scheduledTaskId: "t1", createdBy: "agent", creationSource: "server" }), names), { kind: "routine", label: "Morning triage", text: "hello" });
  assert.equal(queuedSender(message({ scheduledTaskId: "gone" }), names).label, "Routine");
  assert.deepEqual(queuedSender(message({ senderThreadId: "b1", text: "From Roka: done" }), names), { kind: "agent", label: "Roka", text: "done" });
  assert.deepEqual(queuedSender(message({ senderThreadId: "x", text: "From Ada: done" }), names), { kind: "agent", label: "Ada", text: "done" });
  assert.equal(queuedSender(message({ senderThreadId: "x" }), names).label, "Another thread");
  assert.deepEqual(queuedSender(message({ createdBy: "agent", creationSource: "server" }), names), { kind: "server", label: "T3 Code", text: "hello" });
});
