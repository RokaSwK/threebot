import assert from "node:assert/strict";
import { test } from "node:test";
import { keepThreadsActive, settleQuietThreads, type BotOwnership, type QuietThread, type SettleThread } from "./auto-settle.mts";

const sweep = async (owned: (string | null)[], threads: SettleThread[], fail = new Set<string>()) => {
  const sent: object[] = [];
  const logged: string[] = [];
  const switched = await keepThreadsActive(owned, {
    threads: async () => threads,
    dispatch: async (command) => { if (fail.has((command as { threadId: string }).threadId)) throw new Error("refused"); sent.push(command); },
    log: (line) => logged.push(line),
  });
  return { sent, switched, logged };
};

test("turns auto-settle off for owned threads that still have it on", async () => {
  const { sent, switched } = await sweep(["main", "room", null, "kept"], [
    { id: "main", autoSettleDisabledAt: null },
    { id: "room", autoSettleDisabledAt: null },
    { id: "kept", autoSettleDisabledAt: "2026-11-01T00:00:00.000Z" },
    { id: "someone-else", autoSettleDisabledAt: null },
  ]);
  assert.deepEqual(switched, ["main", "room"]);
  assert.deepEqual(sent, [
    { type: "thread.auto-settle.set", threadId: "main", enabled: false },
    { type: "thread.auto-settle.set", threadId: "room", enabled: false },
  ]);
});

test("leaves a T3 without auto-settle and archived threads alone", async () => {
  const { sent } = await sweep(["old", "archived"], [{ id: "old" }, { id: "archived", archivedAt: "2026-11-01T00:00:00.000Z", autoSettleDisabledAt: null }]);
  assert.deepEqual(sent, []);
});

test("one refused thread doesn't stop the rest", async () => {
  const { switched, logged } = await sweep(["a", "b"], [{ id: "a", autoSettleDisabledAt: null }, { id: "b", autoSettleDisabledAt: null }], new Set(["a"]));
  assert.deepEqual(switched, ["b"]);
  assert.match(logged[0]!, /couldn't keep a active: refused/);
});

test("reads nothing when there is nothing to own", async () => {
  let read = false;
  assert.deepEqual(await keepThreadsActive([null], { threads: async () => { read = true; return []; }, dispatch: async () => {} }), []);
  assert.equal(read, false);
});

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const quietAt = "2026-11-16T11:50:00.000Z";
const settle = async (owned: Partial<BotOwnership>, threads: QuietThread[]) => {
  const sent: object[] = [];
  const settled = await settleQuietThreads({ threadIds: [], projectIds: [], rootIds: [], ...owned }, { threads: async () => threads, dispatch: async (command) => { sent.push(command); }, now: NOW });
  return { sent, settled };
};

test("settles quiet Bot threads: main, room, own-project and descendants of a main thread", async () => {
  const { settled, sent } = await settle({ threadIds: ["main", "room"], projectIds: ["bot-project"], rootIds: ["main"] }, [
    { id: "main", status: "idle", latestRunCompletedAt: quietAt },
    { id: "room", status: "idle", latestRunCompletedAt: quietAt },
    { id: "routine", projectId: "bot-project", status: "idle", latestRunCompletedAt: quietAt },
    { id: "child", projectId: "user-repo", status: "idle", latestRunCompletedAt: quietAt, lineage: { rootThreadId: "main", parentThreadId: "main" } },
    { id: "users-own", projectId: "user-repo", status: "idle", latestRunCompletedAt: quietAt },
  ]);
  assert.deepEqual(settled, ["main", "room", "routine", "child"]);
  assert.deepEqual(sent[0], { type: "thread.settle", threadId: "main" });
});

test("leaves busy, waiting, watched, pinned, settled and just-finished Bot threads alone", async () => {
  const { settled } = await settle({ projectIds: ["p"] }, [
    { id: "running", projectId: "p", status: "running", latestRunCompletedAt: quietAt },
    { id: "activity", projectId: "p", status: "idle", activityRunStatus: "starting", latestRunCompletedAt: quietAt },
    { id: "queued-wake", projectId: "p", status: "queued", latestRunCompletedAt: quietAt },
    { id: "asking", projectId: "p", status: "idle", pendingRuntimeRequest: { kind: "approval" }, latestRunCompletedAt: quietAt },
    { id: "subagents", projectId: "p", status: "idle", pendingBackgroundTasks: [{}], latestRunCompletedAt: quietAt },
    { id: "watching-pr", projectId: "p", status: "idle", pullRequests: [{ watch: { mode: "babysit" } }], latestRunCompletedAt: quietAt },
    { id: "limit", projectId: "p", status: "idle", limitRecovery: { resumeAt: "x" }, latestRunCompletedAt: quietAt },
    { id: "merge", projectId: "p", status: "idle", waitingForMergeAt: quietAt, latestRunCompletedAt: quietAt },
    { id: "pinned", projectId: "p", status: "idle", pinnedAt: quietAt, latestRunCompletedAt: quietAt },
    { id: "snoozed", projectId: "p", status: "idle", snoozedUntil: "2026-11-17T00:00:00.000Z", latestRunCompletedAt: quietAt },
    { id: "settled", projectId: "p", status: "idle", settledOverride: "settled", latestRunCompletedAt: quietAt },
    { id: "archived", projectId: "p", status: "idle", archivedAt: quietAt, latestRunCompletedAt: quietAt },
    { id: "just-replied", projectId: "p", status: "idle", latestRunCompletedAt: "2026-11-16T11:59:30.000Z" },
    { id: "just-asked", projectId: "p", status: "idle", latestRunCompletedAt: quietAt, latestUserMessageAt: "2026-11-16T11:59:30.000Z" },
    { id: "visited", projectId: "p", status: "idle", latestRunCompletedAt: quietAt, updatedAt: "2026-11-16T11:59:59.000Z" } as QuietThread,
    { id: "woken", projectId: "p", status: "idle", settledOverride: "active", latestRunCompletedAt: quietAt, pullRequests: [{}] },
  ]);
  assert.deepEqual(settled, ["visited", "woken"]);
});

test("does nothing without Bots", async () => {
  let read = false;
  assert.deepEqual(await settleQuietThreads({ threadIds: [null], projectIds: [], rootIds: [] }, { threads: async () => { read = true; return []; }, dispatch: async () => {} }), []);
  assert.equal(read, false);
});
