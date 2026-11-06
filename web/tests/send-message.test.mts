import assert from "node:assert/strict";
import { buildOnce, entryChunk } from "./support.mts";
import { beforeEach, mock, test } from "node:test";

// Bundle the real store with the app's compiler, including its TypeScript-only syntax.
const storeUrl = new URL("../src/store.ts", import.meta.url).pathname;
const t3Url = new URL("../src/lib/t3.ts", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "send-message-test-entry",
    resolveId: (id) => id.endsWith("virtual:send-message-test") ? "\0send-message-test" : undefined,
    load: (id) => id === "\0send-message-test"
      ? `export { sendMessage, useApp } from ${JSON.stringify(storeUrl)}; export { t3 } from ${JSON.stringify(t3Url)};`
      : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:send-message-test", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry, "test bundle has an entry point");
globalThis.localStorage = { getItem: () => null } as unknown as Storage;
const { sendMessage, useApp, t3 } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

beforeEach(() => {
  mock.restoreAll();
  useApp.setState({ bots: { roka: { slug: "roka", mainThreadId: "main" } }, threads: {} });
});

function captureDispatch() {
  return mock.method(t3, "dispatch", async () => ({ sequence: 1 }));
}

function assertSteeringCommand(dispatch, threadId, text, attachments = []) {
  assert.equal(dispatch.mock.callCount(), 1);
  const { messageId, commandId, ...command } = dispatch.mock.calls[0].arguments[0];
  assert.match(messageId, /^[\da-f-]{36}$/i);
  assert.equal(commandId, messageId, "the same message keeps one idempotent T3 command identity");
  assert.deepEqual(command, {
    type: "message.dispatch",
    threadId,
    text,
    attachments,
    createdBy: "user",
    creationSource: "web",
    // T3 resolves this intent against the live run, overriding saved T3 defaults.
    deliveryIntent: "steer",
    dispatchMode: { type: "start_immediately" },
  });
}

for (const status of ["preparing", "starting", "running", "waiting", "completed", "idle"]) {
  test(`main thread sends with explicit steering intent when ${status}`, async () => {
    const active = !["completed", "idle"].includes(status);
    useApp.setState({ threads: { main: { status, activeRunId: active ? "run-main" : null } } });
    const dispatch = captureDispatch();
    await sendMessage("roka", "Change direction");
    assertSteeringCommand(dispatch, "main", "Change direction");
  });
}

test("steering intent also covers a run that starts before the browser shell updates", async () => {
  const dispatch = captureDispatch();
  await sendMessage("roka", "Continue");
  assertSteeringCommand(dispatch, "main", "Continue");
});

for (const activeRunId of ["run-child", null]) {
  test(`explicit subagent target sends to the child (${activeRunId ? "active" : "idle"})`, async () => {
    const childId = "thread:delegated-task:child";
    useApp.setState({ threads: {
      main: { activeRunId: "run-main", modelSelection: { options: [{ id: "effort", value: "ultrathink" }] } },
      [childId]: { activeRunId, modelSelection: { options: [] } },
    } });
    const dispatch = captureDispatch();
    await sendMessage("roka", "Focus on this", [], childId);
    assertSteeringCommand(dispatch, childId, "Focus on this");
  });
}

test("attachment-only steering preserves wire attachments and the target's Ultrathink setting", async () => {
  useApp.setState({ threads: { main: { activeRunId: "run-main", modelSelection: { options: [{ id: "effort", value: "ultrathink" }] } } } });
  const attachment = { type: "image", id: "upload-1", name: "screen.png", mimeType: "image/png", sizeBytes: 123 };
  const dispatch = captureDispatch();
  await sendMessage("roka", "", [{ ...attachment, previewUrl: "blob:local-preview" }]);
  assertSteeringCommand(dispatch, "main", "", [attachment]);
});

test("text steering retains Ultrathink", async () => {
  useApp.setState({ threads: { main: { modelSelection: { options: [{ id: "effort", value: "ultrathink" }] } } } });
  const dispatch = captureDispatch();
  await sendMessage("roka", "Think through this");
  assertSteeringCommand(dispatch, "main", "Ultrathink: Think through this");
});
