import assert from "node:assert/strict";
import { test } from "node:test";
import { safeEqual } from "./safe-equal.mts";

test("the same text matches and different text doesn't", () => {
  assert.equal(safeEqual("hunter22", "hunter22"), true);
  assert.equal(safeEqual("hunter23", "hunter22"), false);
  assert.equal(safeEqual("short", "hunter22"), false);
});

test("an accented letter with the same character count is a plain mismatch, not a crash", () => {
  assert.equal("hunter2é".length, "hunter22".length);
  assert.equal(safeEqual("hunter2é", "hunter22"), false);
  assert.equal(safeEqual("hunter22", "hunter2é"), false);
});

test("anything that isn't a string is refused", () => {
  for (const value of [undefined, null, 22, ["hunter22"], { toString: () => "hunter22" }]) {
    assert.equal(safeEqual(value, "hunter22"), false);
  }
});
