import assert from "node:assert/strict";
import { test } from "node:test";
import { withFileLock } from "./file-lock.mts";

test("work on the same file runs one caller at a time", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withFileLock("same-file", async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
  });
  const second = withFileLock("same-file", async () => { order.push("second"); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("a failed write releases the next caller", async () => {
  await assert.rejects(() => withFileLock("failing-file", async () => { throw new Error("boom"); }), /boom/u);
  let ran = false;
  await withFileLock("failing-file", async () => { ran = true; });
  assert.equal(ran, true);
});

test("different files do not wait for each other", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = withFileLock("file-a", () => gate);
  let ran = false;
  await withFileLock("file-b", async () => { ran = true; });
  assert.equal(ran, true);
  release();
  await slow;
});
