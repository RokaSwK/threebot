import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "vite";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "avatar-activity-test-entry",
    resolveId: (id) => id.endsWith("virtual:avatar-activity-test") ? "\0avatar-activity-test" : undefined,
    load: (id) => id === "\0avatar-activity-test" ? `export * from ${JSON.stringify(`${src}lib/avatarActivity.ts`)}; export { objectMood } from ${JSON.stringify(`${src}lib/objectAvatars.ts`)}; export { default as config } from ${JSON.stringify(`${src}../../server/avatar-config.json`)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:avatar-activity-test", write: false },
});
const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
assert.ok(entry, "test bundle has an entry point");
const { deriveActivity, holdStep, holdWake, objectMood, config, HOLD_MS, WAKE_MS, CHEER_MS, SPAWN_MS, DROWSY_AFTER_MS, SLEEP_AFTER_MS, CELEBRATE_AFTER_MS } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

const NOW = Date.parse("2026-11-06T03:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const shell = (extra = {}) => ({ id: "t", status: "idle", activityRunStatus: null, activeRunId: null, pendingRuntimeRequest: null, latestRunCompletedAt: iso(NOW - 60_000), latestRunStartedAt: iso(NOW - 90_000), latestUserMessageAt: iso(NOW - 90_000), latestVisibleMessage: null, createdAt: iso(NOW - 86_400_000), updatedAt: iso(NOW), ...extra });
const running = shell({ status: "running", activeRunId: "r1" });
const run = { r1: { id: "r1", ordinal: 1, status: "running" } };
const item = (type, extra = {}) => ({ id: `i-${type}`, runId: "r1", ordinal: 5, status: "running", type, startedAt: iso(NOW - 10_000), ...extra });
const busy = (it, data = {}) => deriveActivity({ shell: running, status: "working", data: { runs: run, items: { [it.id]: it }, ...data } }, NOW).state;

test("each kind of turn item acts out its own state", () => {
  assert.equal(busy(item("reasoning")), "thinking");
  assert.equal(busy(item("web_search")), "searching");
  assert.equal(busy(item("assistant_message", { status: "completed", streaming: true })), "writing");
  assert.equal(busy(item("command_execution")), "working");
  assert.equal(busy(item("file_change")), "writing");
  assert.equal(busy(item("subagent")), "orbit");
  assert.equal(busy(item("subagent", { startedAt: iso(NOW - 500) })), "spawning");
  assert.equal(busy(item("approval_request", { status: "waiting" })), "waiting");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__t3-code__web_fetch" })), "searching");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__t3-code__delegate_task", startedAt: iso(NOW - 20_000) })), "orbit");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__t3-code__task_status" })), "orbit");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__t3-code__t3_thread_send" })), "sending");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__t3-code__t3_attachment_prepare_upload" })), "uploading");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__t3-code__html_render" })), "writing");
  assert.equal(busy(item("dynamic_tool", { toolName: "mcp__x__do_something" })), "working");
});

test("the newest live item wins, and gaps between items read as thinking", () => {
  const older = item("web_search", { id: "a", ordinal: 1 });
  const newer = item("reasoning", { id: "b", ordinal: 2 });
  assert.equal(deriveActivity({ shell: running, status: "working", data: { runs: run, items: { a: older, b: newer } } }, NOW).state, "thinking");
  const done = item("web_search", { status: "completed" });
  assert.equal(busy(done), "thinking");
  assert.equal(deriveActivity({ shell: running, status: "working", data: { runs: run, items: {} } }, NOW).state, "receiving");
  assert.equal(deriveActivity({ shell: running, status: "working", data: { runs: run, items: { [done.id]: done }, subagents: { s: { id: "s", status: "running" } } } }, NOW).state, "orbit");
  // Items from an older run don't count.
  assert.equal(busy(item("web_search", { runId: "old" })), "receiving");
});

test("a spawning subagent turns into an orbit on its own", () => {
  const fresh = item("subagent", { startedAt: iso(NOW - 500) });
  const activity = deriveActivity({ shell: running, status: "working", data: { runs: run, items: { [fresh.id]: fresh } } }, NOW);
  assert.deepEqual(activity, { state: "spawning", until: NOW - 500 + SPAWN_MS });
});

test("without the thread's items, the shell still tells starting, working, waiting and failure apart", () => {
  assert.equal(deriveActivity({ shell: shell({ status: "starting" }), status: "working" }, NOW).state, "receiving");
  assert.equal(deriveActivity({ shell: running, status: "working" }, NOW).state, "working");
  assert.equal(deriveActivity({ shell: running, status: "waiting" }, NOW).state, "waiting");
  assert.equal(deriveActivity({ shell: running, status: "waiting", quietWaiting: true }, NOW).state, "idle");
  assert.equal(deriveActivity({ shell: shell({ status: "failed" }), status: "failed" }, NOW).state, "failed");
  assert.equal(deriveActivity({ status: "new" }, NOW).state, "idle");
  // A resolved child status beats a shell that still says running.
  assert.equal(deriveActivity({ shell: running, status: "failed" }, NOW).state, "failed");
  assert.equal(deriveActivity({ shell: running, status: "completed" }, NOW).state, "idle");
  assert.equal(deriveActivity({ shell: running }, NOW).state, "working");
});

test("this browser's own activity comes first", () => {
  assert.equal(deriveActivity({ shell: running, status: "working", local: "uploading" }, NOW).state, "uploading");
  assert.equal(deriveActivity({ shell: shell(), status: "idle", local: "listening" }, NOW).state, "listening");
  assert.equal(deriveActivity({ shell: shell(), status: "idle", local: "voice-speaking" }, NOW).state, "dictating");
  assert.equal(deriveActivity({ shell: shell(), status: "idle", local: "sending" }, NOW).state, "sending");
});

test("a finished turn cheers, then rests, then dozes off", () => {
  const justDone = shell({ status: "completed", latestRunCompletedAt: iso(NOW - 1000), latestRunStartedAt: iso(NOW - 20_000) });
  assert.deepEqual(deriveActivity({ shell: justDone, status: "unread" }, NOW), { state: "happy", until: NOW - 1000 + CHEER_MS });
  const longRun = { ...justDone, latestRunStartedAt: iso(NOW - 1000 - CELEBRATE_AFTER_MS) };
  assert.equal(deriveActivity({ shell: longRun, status: "done" }, NOW).state, "celebrate");
  assert.equal(deriveActivity({ shell: { ...justDone, status: "failed" }, status: "failed" }, NOW).state, "failed");
  const after = NOW + CHEER_MS;
  assert.equal(deriveActivity({ shell: justDone, status: "idle" }, after).state, "idle");
  const last = NOW - 1000;
  assert.deepEqual(deriveActivity({ shell: justDone, status: "idle" }, after), { state: "idle", until: last + DROWSY_AFTER_MS });
  assert.equal(deriveActivity({ shell: justDone, status: "idle" }, last + DROWSY_AFTER_MS).state, "drowsy");
  assert.equal(deriveActivity({ shell: justDone, status: "done" }, last + SLEEP_AFTER_MS).state, "sleeping");
  // Something unread keeps it awake.
  assert.equal(deriveActivity({ shell: justDone, status: "unread" }, last + SLEEP_AFTER_MS).state, "idle");
});

test("the hold keeps each state on screen and smooths quick switches", () => {
  let hold = holdStep(null, "thinking", NOW);
  assert.equal(hold.shown, "thinking");
  hold = holdStep(hold, "searching", NOW + 300);
  assert.equal(hold.shown, "thinking", "a change inside the hold waits");
  assert.equal(holdWake(hold, "searching"), NOW + HOLD_MS);
  hold = holdStep(hold, "thinking", NOW + 600);
  assert.equal(hold.shown, "thinking", "A→B→A inside the hold never shows B");
  assert.equal(holdWake(hold, "thinking"), null);
  hold = holdStep(hold, "searching", NOW + HOLD_MS);
  assert.equal(hold.shown, "searching");
  assert.equal(hold.since, NOW + HOLD_MS);
});

test("waiting and failures skip the hold", () => {
  const hold = holdStep(holdStep(null, "writing", NOW), "waiting", NOW + 100);
  assert.equal(hold.shown, "waiting");
  assert.equal(holdStep(hold, "failed", NOW + 200).shown, "failed");
});

test("a sleeping Bot wakes up before it starts work", () => {
  let hold = holdStep(null, "sleeping", NOW);
  hold = holdStep(hold, "thinking", NOW + HOLD_MS);
  assert.equal(hold.shown, "waking");
  assert.equal(holdStep(hold, "thinking", NOW + HOLD_MS + WAKE_MS - 1).shown, "waking");
  assert.equal(holdStep(hold, "thinking", NOW + HOLD_MS + WAKE_MS).shown, "thinking");
  // Waking only happens on the way to work.
  assert.equal(holdStep(holdStep(null, "sleeping", NOW), "idle", NOW + HOLD_MS).shown, "idle");
});

test("every state it can pick exists in the engine, and objects get a close mood", () => {
  const picked = ["thinking", "searching", "writing", "working", "sending", "receiving", "uploading", "spawning", "orbit", "listening", "dictating", "waiting", "failed", "happy", "celebrate", "idle", "drowsy", "sleeping", "waking"];
  for (const state of picked) assert.ok(Object.hasOwn(config.states, state), state);
  assert.equal(objectMood("searching"), "thinking");
  assert.equal(objectMood("orbit"), "thinking");
  assert.equal(objectMood("waiting"), "thinking");
  assert.equal(objectMood("celebrate"), "happy");
  assert.equal(objectMood("sleeping"), "idle");
  // Normal work never picks the ring-shaped states.
  assert.ok(!picked.some((state) => ["loading", "progress", "radar"].includes(state)));
});

