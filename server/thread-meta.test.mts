import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createThreadMeta, createThreadPreviews, latestPreview, previewText, type TurnItem } from "./thread-meta.mts";

const message = (ordinal: number, type: string, fields?: Partial<TurnItem>): TurnItem => ({ ordinal, type, startedAt: `2026-10-30T10:00:0${ordinal}.000Z`, ...fields });

test("preview text reads as prose and hides reply context and attachment references", () => {
  assert.equal(previewText("<reply-context>\nOld\n</reply-context>\n\n**Ship** the [report](https://x.test) `now`"), "Ship the report now");
  assert.equal(previewText("![a.csv](t3-context://1)\n# Title\n- item"), "Title item");
  assert.equal(previewText("Ultrathink: go"), "go");
  assert.equal(previewText("Sent it to <t3-thread://v2/env/thread>."), "Sent it to.");
});

test("the newest recognizable item wins, including attachments, questions and Bot sends", () => {
  const preview = (...items: TurnItem[]) => latestPreview({ turnItems: items }, (id) => id === "peer" ? "Peer" : null);
  assert.deepEqual(preview(message(1, "user_message", { text: "hi" }), message(2, "reasoning", { text: "hidden" })), { kind: "text", role: "user", text: "hi", at: "2026-10-30T10:00:01.000Z" });
  assert.equal(preview(message(1, "assistant_message", { text: "", attachments: [{}] }))!.text, "Attachment");
  assert.equal(preview(message(1, "user_input_request", { questions: [{ question: "Which one?" }] }))!.kind, "question");
  assert.equal(preview(message(1, "dynamic_tool", { status: "completed", toolName: "mcp__t3__t3_thread_send", input: JSON.stringify({ threadId: "peer", message: "Done" }) }))!.text, "Messaged Peer: Done");
  assert.equal(preview(message(1, "dynamic_tool", { status: "failed", toolName: "t3_thread_send", input: "{}" })), null);
  assert.equal(latestPreview({ visibleTurnItems: [{ item: message(1, "assistant_message", { text: "wrapped" }) }] })!.text, "wrapped");
});

test("previews reload only moved threads and never pass an older stamp off as a fresh notification body", async () => {
  const calls: string[] = [];
  let failing = false;
  const previews = createThreadPreviews({
    nameFor: async () => () => null,
    projection: async (id) => {
      calls.push(id);
      if (failing) throw new Error("offline");
      return { turnItems: [message(calls.length, "assistant_message", { text: `reply ${calls.length}` })] };
    },
  });
  assert.equal((await previews({ a: "1" })).a.text, "reply 1");
  assert.equal((await previews({ a: "1" })).a.text, "reply 1");
  assert.equal(calls.length, 1);
  failing = true;
  assert.equal((await previews({ a: "2" })).a, undefined);
  assert.equal((await previews({ a: "1" })).a.text, "reply 1");
  failing = false;
  assert.equal((await previews({ a: "2" })).a.text, "reply 3");
  await assert.rejects(previews({ "../bad": "1" }), { status: 400 });
  await assert.rejects(previews([]), { status: 400 });
});

test("reactions toggle per emoji, persist, and reject anything but emoji", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bot-thread-meta-"));
  try {
    const file = path.join(directory, "meta.json");
    const meta = createThreadMeta({ file });
    await meta.toggleReaction({ threadId: "t", itemId: "m", emoji: "🔥" });
    assert.deepEqual((await meta.toggleReaction({ threadId: "t", itemId: "m", emoji: "👍🏽" })).reactions.m, ["🔥", "👍🏽"]);
    assert.deepEqual((await meta.toggleReaction({ threadId: "t", itemId: "m", emoji: "🔥" })).reactions.m, ["👍🏽"]);
    assert.deepEqual((await createThreadMeta({ file }).get("t")).reactions, { m: ["👍🏽"] });
    assert.deepEqual((await meta.toggleReaction({ threadId: "t", itemId: "m", emoji: "👍🏽" })).reactions, {});
    for (const emoji of ["<b>", "hello", "1", "#", ""]) await assert.rejects(meta.toggleReaction({ threadId: "t", itemId: "m", emoji }), { status: 400 });
    assert.ok(JSON.parse(await readFile(file, "utf8")).t);
  } finally { await rm(directory, { recursive: true }); }
});

test("voice calls record a bounded duration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bot-thread-meta-"));
  try {
    const meta = createThreadMeta({ file: path.join(directory, "meta.json"), now: () => "2026-10-30T21:46:00.000Z" });
    assert.deepEqual((await meta.addVoiceCall({ threadId: "t", seconds: 35.4 })).voiceCalls, [{ at: "2026-10-30T21:46:00.000Z", seconds: 35 }]);
    await assert.rejects(meta.addVoiceCall({ threadId: "t", seconds: -1 }), { status: 400 });
    await assert.rejects(meta.addVoiceCall({ threadId: "t", seconds: Number.NaN }), { status: 400 });
  } finally { await rm(directory, { recursive: true }); }
});

test("failed voice calls below ten seconds disappear without rewriting stored history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bot-short-voice-"));
  try {
    const file = path.join(directory, "meta.json");
    const saved = JSON.stringify({ t: { reactions: {}, voiceCalls: [{ at: "old", seconds: 0 }, { at: "short", seconds: 9 }, { at: "valid", seconds: 10 }] } });
    await writeFile(file, saved);
    assert.deepEqual((await createThreadMeta({ file }).get("t")).voiceCalls, [{ at: "valid", seconds: 10 }]);
    assert.equal(await readFile(file, "utf8"), saved);
  } finally { await rm(directory, { recursive: true }); }
});
