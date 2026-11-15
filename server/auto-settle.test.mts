import assert from "node:assert/strict";
import { test } from "node:test";
import { keepThreadsActive, type SettleThread } from "./auto-settle.mts";

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
