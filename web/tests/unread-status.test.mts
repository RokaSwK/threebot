import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

// Exercise the actual store selector with wire-shaped thread summaries. T3 marks
// unread by rewinding the completion watermark, not the assistant message time.
globalThis.localStorage = { getItem: () => null } as unknown as Storage;
const store = new URL("../src/store.ts", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent",
  build: { ssr: store, write: false }, ssr: { noExternal: true },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const directory = await mkdtemp(join(tmpdir(), "bot-unread-status-"));
let botStatus, useApp;
try {
  const file = join(directory, "store.mjs"); await writeFile(file, entry.code);
  ({ botStatus, useApp } = await import(pathToFileURL(file).href));
} finally { await rm(directory, { recursive: true }); }
const bot = { slug: "example", mainThreadId: "main" };
const thread = {
  id: "main", status: "completed", pendingRuntimeRequest: null,
  latestRunCompletedAt: "2026-10-30T10:01:00.000Z", lastVisitedAt: "2026-10-30T10:00:59.999Z",
  latestVisibleMessage: { role: "assistant", text: "Done", updatedAt: "2026-10-30T10:00:00.000Z" },
};
const status = (summary, selected = null) => {
  useApp.setState({ threads: { main: summary }, selected });
  return botStatus(bot);
};

test("mark-unread completion watermark shows unread even when the assistant message ended earlier", () => {
  assert.equal(status(thread), "unread");
  assert.equal(status({ ...thread, lastVisitedAt: thread.latestRunCompletedAt }), "idle");
  assert.equal(status(thread, bot.slug), "idle", "the open Bot does not show a new-message badge");
  assert.equal(status(thread, "another-bot"), "unread", "leaving exposes the authoritative unread state");
});

test("completion alone can mark an output-only run unread", () => {
  assert.equal(status({ ...thread, latestVisibleMessage: null }), "unread");
  assert.equal(status({ ...thread, latestVisibleMessage: null, lastVisitedAt: thread.latestRunCompletedAt }), "idle");
});

test("legacy servers keep the assistant-time fallback while authoritative null stays empty", () => {
  const { latestRunCompletedAt: ignored, ...legacy } = thread;
  assert.equal(status({ ...legacy, lastVisitedAt: null }), "unread");
  assert.equal(status(legacy), "idle");
  assert.equal(status({ ...thread, latestRunCompletedAt: null, lastVisitedAt: null }), "idle");
  assert.equal(status({ ...legacy, lastVisitedAt: null, latestVisibleMessage: { ...legacy.latestVisibleMessage, role: "user" } }), "idle");
});

test("pending requests and active work keep precedence over unread completion", () => {
  assert.equal(status({ ...thread, pendingRuntimeRequest: { id: "question", kind: "user_input", blocking: true } }), "waiting");
  assert.equal(status({ ...thread, status: "running" }), "working");
  assert.equal(status({ ...thread, status: "waiting" }), "working");
  assert.equal(status({ ...thread, status: "failed", lastVisitedAt: thread.latestRunCompletedAt }), "failed");
});
