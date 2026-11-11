import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";
import type { Question } from "../src/lib/runtimeRequests.ts";
import type { RuntimeRequest, TurnItem } from "../src/lib/types.ts";

// Real React DOM and store; only the RPC transport boundary is mocked.
// Generic server snapshots below are fixtures, never live request responses.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "http://runtime-cards.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "runtime-cards-test-entry", resolveId: (id) => id.endsWith("virtual:runtime-cards-tests") ? "\0runtime-cards-tests" : undefined,
    load: (id) => id === "\0runtime-cards-tests" ? `
      export { createElement, act, useState } from "react";
      export { createRoot } from "react-dom/client";
      export { ApprovalCard, QuestionCard, SecretCard, SubagentCard } from ${JSON.stringify(`${src}components/Cards.tsx`)};
      export { ModelPicker } from ${JSON.stringify(`${src}components/ModelPicker.tsx`)};
      export { buildEntries } from ${JSON.stringify(`${src}lib/transcript.ts`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:runtime-cards-tests", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const testDir = await mkdtemp(join(tmpdir(), "bot-runtime-cards-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entry.code);
const { createElement: h, act, useState, createRoot, ApprovalCard, QuestionCard, SecretCard, SubagentCard, ModelPicker, buildEntries, useApp, t3 } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });
let root, host, calls, transport, questionViews;
beforeEach(() => {
  calls = [];
  questionViews = new Map();
  transport = (tag) => tag === 'orchestration.getThreadFamily' ? Promise.resolve({ threads: [] }) : new Promise(() => {});
  t3.call = (tag, payload) => { calls.push({ tag, payload }); return transport(tag, payload); };
  globalThis.fetch = () => assert.fail("HTTP is outside this test boundary");
  useApp.setState({ bots: {}, historicalBots: {}, threads: {}, threadData: {}, toast: null });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    // Test requests are independent. End their authoritative lifetime rather
    // than assuming an unmounted request no longer owns its unfinished work.
    for (const { value, threadId } of questionViews.values()) useApp.setState({ threadData: {
      [threadId]: { loaded: true, runs: {}, items: { [value.item.id]: { ...value.item, status: "cancelled" } }, requests: {} },
    } });
  });
  document.body.replaceChildren();
});
const question: Question = { id: "choice", header: "Example", question: "Which example?", options: [{ label: "First", description: "First example", value: "first-id" }, { label: "Second", description: "Second example", value: "second-id" }] };
// The app's item shape, without `parentItemId`, which these cards never read.
type ItemFixture = { [K in keyof TurnItem as K extends "parentItemId" ? never : K]: TurnItem[K] };
const item = (type: string, extra: Partial<ItemFixture> = {}): ItemFixture => ({ id: "card-1", threadId: "thread-1", runId: "run-1", ordinal: 1, status: "waiting", title: null, type, startedAt: null, completedAt: null, updatedAt: "2026-01-01T00:00:00Z", requestId: "request-1", ...extra });
type RequestFixture = RuntimeRequest & { decision?: string; answers?: Record<string, unknown>; responseCapability?: { type: string; providerSessionId?: string } };
const request = (extra: Partial<RequestFixture> = {}): RequestFixture => ({ id: "request-1", kind: "user_input", status: "pending", responseCapability: { type: "live", providerSessionId: "session-1" }, ...extra });
const fixtures = {
  approval: () => ({ kind: "approval", id: "card-1", item: item("approval_request", { requestKind: "command", title: "Example action" }), request: request({ kind: "command" }) }),
  question: () => ({ kind: "question", id: "card-1", item: item("user_input_request", { questions: [question] }), request: request() }),
  secret: () => ({ kind: "secret", id: "card-1", item: item("secret_request", { secretStatus: "pending", label: "Example credential", reason: "Needed for an example" }) }),
};
const components = { approval: ApprovalCard, question: QuestionCard, secret: SecretCard };
const render = async (kind, value = fixtures[kind](), threadId = "thread-1") => {
  if (kind === "question") questionViews.set(JSON.stringify([threadId, value.item.id]), { value, threadId });
  await act(async () => root.render(h(components[kind], { entry: value, threadId })));
};
const button = (text) => [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === text || el.textContent.includes(text));
const click = async (el) => { assert.ok(el, "control exists"); await act(async () => el.click()); };
const input = async (el, value) => act(async () => {
  assert.ok(el, "input exists"); Object.getOwnPropertyDescriptor(el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, "value").set.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true })); el.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const submit = async () => act(async () => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); transport = () => promise; return { resolve, reject }; };
const assertCommand = (command, index = 0) => { const { commandId, ...actual } = calls[index].payload; assert.equal(calls[index].tag, "orchestration.dispatchCommand"); assert.equal(typeof commandId, "string"); assert.deepEqual(actual, { threadId: "thread-1", requestId: "request-1", ...command }); };

for (const status of ['running', 'completed', 'cancelled', 'failed', 'interrupted']) test(`subagent card preserves ${status}, identity and child navigation`, async () => {
  const bot = { slug: 'parent', name: 'Parent Bot', mainThreadId: 'root', shape: 'blob', color: 'teal' };
  const value = item('subagent', { id: 'child-card', childThreadId: 'child', status, title: 'A long child title that must remain readable on a small phone without hiding the status or the navigation action' });
  useApp.setState({ bots: { parent: bot }, threads: { root: { id: 'root', lineage: { parentThreadId: null } }, child: { id: 'child', title: value.title, status: 'idle', lineage: { parentThreadId: 'root' }, updatedAt: value.updatedAt } } });
  await act(async () => root.render(h(SubagentCard, { entry: { kind: 'subagent', id: value.id, item: value }, bot, threadId: 'root' })));
  const link = host.querySelector('[data-thread-id="child"]');
  assert.equal(link.dataset.subagentStatus, status);
  assert.equal(link.dataset.avatarColor, 'teal');
  assert.notEqual(link.dataset.avatarShape, 'blob');
  assert.doesNotMatch(host.textContent, /From Parent Bot|Open chat|claude-/);
  assert.match(link.getAttribute('href'), /bot=parent&thread=child/);
  await click(link); assert.equal(useApp.getState().selectedThreadId, 'child');
  assert.equal(calls.filter(call => call.tag === 'orchestration.getThreadFamily').length, 1);
});

test('remote child cards open the exact machine and live subagent updates replace stale items', async () => {
  const bot = { slug: 'parent', name: 'Parent', mainThreadId: 'root', shape: 'blob', color: 'teal' };
  const value = item('subagent', { subagentId: 'agent', status: 'running', childThreadId: null, remoteChild: { environmentId: 'machine', threadId: 'remote-child', label: 'Other Mac' } });
  useApp.setState({ bots: { parent: bot }, threadData: { root: { subagents: { agent: { ...value, id: 'agent', title: 'Finished remotely', status: 'completed', updatedAt: '2026-01-02T00:00:00Z' } } } } });
  await act(async () => root.render(h(SubagentCard, { entry: { kind: 'subagent', id: value.id, item: value }, bot, threadId: 'root' })));
  const link = host.querySelector('a');
  assert.equal(link.dataset.subagentStatus, 'completed');
  assert.equal(link.getAttribute('href'), '/api/thread-link?environmentId=machine&threadId=remote-child');
  assert.equal(link.target, '_blank'); assert.match(host.textContent, /Other Mac/);
});

for (const [status, label] of [["expired", "Expired"], ["cancelled", "Cancelled"], ["resolved", "Resolved"]] as const) test(`approval ${status} is truthful and non-actionable`, async () => {
  const value = fixtures.approval(); value.request.status = status; await render("approval", value);
  assert.match(document.body.textContent, new RegExp(label)); assert.equal(document.querySelectorAll("button").length, 0); assert.equal(calls.length, 0);
});

test("resolved approval uses authoritative request decision over stale item", async () => {
  const value = fixtures.approval(); value.item.decision = "accept"; value.request = request({ status: "resolved", decision: "decline" });
  await render("approval", value); assert.match(document.body.textContent, /Denied/); assert.doesNotMatch(document.body.textContent, /Allowed/);
});

test("approval presents only provider choices and sends their existing decisions", async () => {
  const value = fixtures.approval(); value.item.options = [{ decision: "acceptForSession", label: "Allow for session", warning: "Applies for this session" }, { decision: "decline", label: "Reject action" }];
  await render("approval", value); assert.equal(document.querySelectorAll("button").length, 2); assert.match(document.body.textContent, /Applies for this session/);
  await click(button("Allow for session")); assertCommand({ type: "runtime-request.respond", decision: "acceptForSession" });
});

for (const kind of ["approval", "question"]) test(`${kind} not_resumable request has no response controls`, async () => {
  const value = fixtures[kind](); value.request.responseCapability = { type: "not_resumable", reason: "Example session ended" }; await render(kind, value);
  assert.equal([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].filter((el) => !el.disabled).length, 0); assert.match(document.body.textContent, /Unavailable/); assert.equal(calls.length, 0);
});

test("the model selector lists T3's models and writes T3 selections", async () => {
  const effort = { id: "effort", label: "Reasoning", type: "select", options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], currentValue: "low" };
  const fast = { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false };
  const providers = [
    { instanceId: "claude", driver: "claudeAgent", displayName: "Claude", enabled: true, status: "ready", models: [{ slug: "opus", name: "Claude Opus", capabilities: { optionDescriptors: [effort, fast] } }, { slug: "hidden", name: "Claude Hidden" }, { slug: "sonnet", name: "Claude Sonnet", capabilities: { optionDescriptors: [effort] } }] },
    { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, status: "ready", models: [{ slug: "gpt", name: "GPT-6.1 Sol" }] },
  ];
  useApp.setState({ providers, providerModelPreferences: { claude: { hiddenModels: ["hidden"], modelOrder: [] } } });
  const seen = [];
  const View = () => { const [value, setValue] = useState({ instanceId: "claude", model: "opus", options: [{ id: "effort", value: "low" }] }); return h(ModelPicker, { value, onChange: (next) => { seen.push(next); setValue(next); } }); };
  await act(async () => root.render(h(View)));
  assert.match(host.querySelector(".model-trigger").textContent, /Opus.*Low/);
  await click(host.querySelector(".model-trigger"));
  assert.deepEqual([...document.querySelectorAll(".model-row")].map((row) => row.textContent), ["Claude Opus", "Claude Sonnet"]);
  await click(button("High"));
  assert.deepEqual(seen.at(-1), { instanceId: "claude", model: "opus", options: [{ id: "effort", value: "high" }, { id: "fastMode", value: false }] });
  await click(document.querySelector('[role="switch"]'));
  assert.deepEqual(seen.at(-1).options.find((option) => option.id === "fastMode"), { id: "fastMode", value: true });
  await click([...document.querySelectorAll(".model-row")].find((row) => row.textContent === "Claude Sonnet"));
  assert.deepEqual(seen.at(-1), { instanceId: "claude", model: "sonnet", options: [{ id: "effort", value: "high" }] });
  await click([...document.querySelectorAll(".model-tab")].find((tab) => tab.textContent.includes("Codex")));
  await click([...document.querySelectorAll(".model-row")].find((row) => row.textContent.includes("GPT-6.1 Sol")));
  assert.deepEqual(seen.at(-1), { instanceId: "codex", model: "gpt", options: [] });
});

test("the model selector displays subProvider, supports favorites and filters by subProvider", async () => {
  localStorage.clear();
  const providers = [
    {
      instanceId: "pi",
      driver: "pi",
      displayName: "Pi",
      enabled: true,
      status: "ready",
      models: [
        { slug: "fable", name: "Claude Fable 5", subProvider: "anthropic" },
        { slug: "deepseek", name: "DeepSeek v4", subProvider: "opendesign" },
        { slug: "default", name: "Pi Default" },
      ],
    },
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "gpt", name: "GPT-6.1 Sol" }],
    },
  ];
  useApp.setState({ providers, providerModelPreferences: {} });
  const seen = [];
  const View = () => {
    const [value, setValue] = useState({ instanceId: "pi", model: "fable" });
    return h(ModelPicker, { value, onChange: (next) => { seen.push(next); setValue(next); } });
  };
  await act(async () => root.render(h(View)));
  await click(host.querySelector(".model-trigger"));

  const rows = [...document.querySelectorAll(".model-row")];
  assert.equal(rows.length, 3);
  assert.ok(rows[0].querySelector(".model-subprovider"));
  assert.equal(rows[0].querySelector(".model-subprovider").textContent, "anthropic");
  assert.equal(rows[1].querySelector(".model-subprovider").textContent, "opendesign");
  assert.equal(rows[2].querySelector(".model-subprovider"), null);

  const starBtns = [...document.querySelectorAll(".model-star")];
  assert.equal(starBtns.length, 3);
  await click(starBtns[0]);

  const favTab = [...document.querySelectorAll(".model-tab")].find((tab) => tab.textContent.includes("Favorites"));
  assert.ok(favTab);
  await click(favTab);

  const favRows = [...document.querySelectorAll(".model-row")];
  assert.equal(favRows.length, 1);
  assert.match(favRows[0].textContent, /Claude Fable 5/);

  const input = document.querySelector<HTMLInputElement>(".model-search");
  assert.ok(input);
  await act(async () => {
    input.value = "anthropic";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const filteredRows = [...document.querySelectorAll(".model-row")];
  assert.equal(filteredRows.length, 1);
  assert.match(filteredRows[0].textContent, /anthropic/);
});

test("short choices are pills in a row with what they mean underneath", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, options: [{ label: "Send", description: "Send it now" }, { label: "Not yet", description: "Hold it" }] }]; await render("question", value);
  assert.equal(document.querySelector<HTMLElement>(".question-options").dataset.layout, "row");
  assert.equal(document.querySelector(".question-option-notes").textContent, "Send it now · Hold it");
  assert.equal(document.querySelectorAll(".question-option .question-option-description").length, 0);
});

test("many choices stack and keep their descriptions on each row", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, options: ["One", "Two", "Three", "Four"].map((label) => ({ label, description: `About ${label}` })) }]; await render("question", value);
  assert.equal(document.querySelector<HTMLElement>(".question-options").dataset.layout, "stack");
  assert.equal(document.querySelectorAll(".question-option .question-option-description").length, 4);
  assert.ok(!document.querySelector(".question-option-notes"));
});

test("question submits option value rather than display label", async () => {
  await render("question"); await click(button("First")); assertCommand({ type: "runtime-request.respond", answers: { choice: "first-id" } });
});

test("question suppresses prohibited custom answers and live dismiss", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, allowCustomAnswer: false }]; await render("question", value);
  assert.ok(!button("Something else"), "custom control is unavailable"); assert.ok(!document.querySelector('[aria-label="Dismiss"]'), "dismiss is unavailable");
});

test("message question dismissal sends existing dismiss command once", async () => {
  const value = fixtures.question(); value.request.responseCapability = { type: "message" }; await render("question", value);
  const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]');
  await act(async () => { dismiss.click(); dismiss.click(); }); assert.equal(calls.length, 1); assertCommand({ type: "thread.user-input.dismiss" });
  assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].every((el) => el.disabled));
});

test("resolved question reads nested attachment-answer payload and request answers", async () => {
  const value = fixtures.question(); value.request = undefined; value.item.status = "completed"; value.item.questionAnswer = { requestId: "request-1", answers: { choice: "first-id" }, attachmentsByQuestionId: {} };
  await render("question", value);
  assert.equal(button("First").getAttribute("aria-pressed"), "true");
  assert.equal(button("First").querySelector("svg"), null, "native accepted choices retain their letter badge");
  assert.equal(button("First").querySelector("span").textContent, "A");
  assert.equal(button("Second"), undefined, "unchosen options are omitted from history");
  value.request = request({ status: "resolved", answers: { choice: "second-id" } }); await render("question", value);
  assert.equal(button("Second").getAttribute("aria-pressed"), "true");
  assert.equal(button("Second").querySelector("span").textContent, "B");
  assert.equal(button("First"), undefined);
});

for (const status of ["expired", "cancelled", "resolved"] as const) test(`question ${status} stops action even with stale waiting item`, async () => {
  const value = fixtures.question(); value.request.status = status; await render("question", value);
  assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].every((el) => el.disabled)); assert.match(document.body.textContent, new RegExp(status === "resolved" ? "Answered" : status, "i")); assert.equal(calls.length, 0);
});

for (const kind of ["approval", "question"]) test(`${kind} guards same-tick clicks and awaits authoritative state after RPC acknowledgment`, async () => {
  const pending = deferred(); await render(kind); const action = button(kind === "approval" ? "Allow once" : "First");
  await act(async () => { action.click(); action.click(); }); assert.equal(calls.length, 1);
  await act(async () => pending.resolve());
  assert.match(document.body.textContent, /Waiting for confirmation/); assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].every((el) => el.disabled));
  await click(action); assert.equal(calls.length, 1);
  const value = fixtures[kind](); value.request.status = "resolved"; await render(kind, value);
  assert.doesNotMatch(document.body.textContent, /Waiting for confirmation/);
});

test("canonical runtime request id is submitted when transcript matched a legacy suffix", async () => {
  const value = fixtures.approval(); value.request.id = "canonical:request-1"; await render("approval", value); await click(button("Deny"));
  assertCommand({ type: "runtime-request.respond", requestId: "canonical:request-1", decision: "decline" });
});

// These tests execute only after failure handling exists, so the before-fix run
// cannot dump an unhandled transport error containing sensitive input.
test("question transport failure retains custom draft and supports retry", async () => {
  await render("question"); assert.equal(document.querySelector('[role="alert"]'), null);
  assert.ok(!document.querySelector('[aria-label="Dismiss"]'), "live request cannot dismiss");
  const pending = deferred(); await click(button("Something else")); await input(document.querySelector("input"), "My example answer"); await submit();
  assert.ok(document.querySelector("input").disabled); await act(async () => pending.reject(new Error("Transport unavailable")));
  assert.match(document.querySelector('[role="alert"]').textContent, /Try again/); assert.equal(document.querySelector("input").value, "My example answer");
  deferred(); await submit(); assert.equal(calls.length, 2); assertCommand({ type: "runtime-request.respond", answers: { choice: "My example answer" } }, 1);
});

test("approval failure is handled and retries the chosen decision", async () => {
  const value = fixtures.approval(); value.request.status = "cancelled"; await render("approval", value); assert.match(document.body.textContent, /Cancelled/);
  value.request.status = "pending"; const pending = deferred(); await render("approval", value); await click(button("Deny")); await act(async () => pending.reject(new Error("Transport unavailable")));
  assert.match(document.querySelector('[role="alert"]').textContent, /Try again/); deferred(); await click(button("Deny")); assert.equal(calls.length, 2); assertCommand({ type: "runtime-request.respond", decision: "decline" }, 1);
});

test("multi-step multi-select and custom answers submit one complete payload", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, multiSelect: true }, { id: "detail", question: "Add detail", options: [], allowCustomAnswer: true }];
  await render("question", value); await click(button("First")); await click(button("Second")); await click(button("Next")); assert.equal(calls.length, 0);
  await click(button("Something else")); await input(document.querySelector("input"), "Detail"); await submit();
  assertCommand({ type: "runtime-request.respond", answers: { choice: ["first-id", "second-id"], detail: "Detail" } });
});

test("question Back preserves selections and the unfinished editor without sending", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, multiSelect: true }, { id: "detail", question: "Add detail", options: [], allowCustomAnswer: true }];
  await render("question", value); await click(button("First")); await click(button("Second")); await click(button("Next"));
  await click(button("Something else")); await input(document.querySelector("input"), "Unfinished detail");
  await click(button("Back"));
  assert.equal(button("First").getAttribute("aria-pressed"), "true");
  assert.equal(button("Second").getAttribute("aria-pressed"), "true");
  await click(button("Next"));
  assert.equal(document.querySelector("input").value, "Unfinished detail");
  assert.equal(calls.length, 0);
  await submit(); assertCommand({ type: "runtime-request.respond", answers: { choice: ["first-id", "second-id"], detail: "Unfinished detail" } });
});

test("question proposed answer opens a literal multiline editor without submitting", async () => {
  const value = fixtures.question();
  const proposed = "  Proposed message\n\nSecond line  \n";
  value.item.questions = [{ ...question, options: [], initialAnswer: proposed }];
  await render("question", value);
  assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your own answer"]')?.value, proposed);
  assert.equal(calls.length, 0, "a proposed answer still needs explicit submission");
  const edited = "  Edited message\n\nKeep trailing space  \n";
  await input(document.querySelector("textarea"), edited);
  await render("question", structuredClone(value));
  assert.equal(document.querySelector("textarea").value, edited, "refresh preserves user edits");
  await submit();
  assertCommand({ type: "runtime-request.respond", answers: { choice: edited } });
});

test("each question seeds only its own permitted proposed answer", async () => {
  const value = fixtures.question();
  value.item.questions = [{ ...question, initialAnswer: "Ignored proposal", allowCustomAnswer: false }, { id: "detail", question: "Review detail", options: [], initialAnswer: "  Detail\n" }];
  await render("question", value);
  assert.equal(document.querySelector("textarea"), null);
  await click(button("First"));
  assert.equal(document.querySelector("textarea")?.value, "  Detail\n");
  assert.equal(calls.length, 0);
  await submit();
  assertCommand({ type: "runtime-request.respond", answers: { choice: "first-id", detail: "  Detail\n" } });
});

test("resolved custom answer shows authoritative literal multiline text", async () => {
  const value = fixtures.question();
  const literal = "  Accepted <b>literal</b> answer\n\nKeep trailing space  \n";
  value.item.status = "completed";
  value.item.questions = [{ ...question, options: [], initialAnswer: "Unsubmitted proposal" }];
  value.item.questionAnswer = { requestId: "request-1", answers: { choice: literal }, attachmentsByQuestionId: {}, questionTextById: { choice: question.question } };
  value.request = undefined;
  await render("question", value);
  assert.ok(document.body.textContent.includes(literal), "accepted custom text retains exact whitespace");
  assert.equal(document.querySelector("b"), null, "answer text is not interpreted as HTML");
  assert.doesNotMatch(document.body.textContent, /Unsubmitted proposal/);
  assert.equal(document.querySelectorAll("input,textarea").length, 0);
  assert.equal(calls.length, 0);
});

test("resolved multi-step history reviews one answer at a time without sending", async () => {
  const value = fixtures.question();
  value.item.questions = [{ ...question, multiSelect: true }, { id: "detail", question: "Add accepted detail", options: [], allowCustomAnswer: true }];
  value.request = request({ status: "resolved", answers: { choice: ["first-id", "second-id"], detail: "  Accepted detail\n" } });
  await render("question", value);
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.match(document.body.textContent, /Which example\?/);
  assert.doesNotMatch(document.body.textContent, /Add accepted detail/);
  assert.equal(button("First").getAttribute("aria-pressed"), "true");
  assert.equal(button("Second").getAttribute("aria-pressed"), "true");
  assert.doesNotMatch(document.body.textContent, /first-id|second-id/);
  assert.equal(button("First").disabled, true);
  assert.equal(button("Second").disabled, true);
  await click(button("Next"));
  assert.match(document.body.textContent, /Add accepted detail/);
  assert.ok(document.body.textContent.includes("  Accepted detail\n"));
  assert.equal(button("First"), undefined);
  assert.equal(button("Next").disabled, true);
  await click(button("Back"));
  assert.match(document.body.textContent, /Which example\?/);
  assert.doesNotMatch(document.body.textContent, /Add accepted detail/);
  assert.equal(document.querySelectorAll("input,textarea").length, 0);
  assert.equal(calls.length, 0);
});

test("server-confirmed answer replaces local draft and stale turn-item answer", async () => {
  const value = fixtures.question();
  value.item.questions = [{ ...question, options: [], initialAnswer: "Original proposal" }];
  const pending = deferred();
  await render("question", value);
  await input(document.querySelector("textarea"), "Local submitted draft");
  await submit();
  await act(async () => pending.resolve());
  assert.match(document.body.textContent, /Waiting for confirmation/);
  value.item.questionAnswer = { requestId: "request-1", answers: { choice: "Stale turn answer" }, attachmentsByQuestionId: {} };
  value.request = request({ status: "resolved", answers: { choice: "Server-confirmed final answer" } });
  await render("question", value);
  assert.match(document.body.textContent, /Server-confirmed final answer/);
  assert.doesNotMatch(document.body.textContent, /Local submitted draft|Stale turn answer|Original proposal|Waiting for confirmation/);
  assert.equal(document.querySelectorAll("textarea,input").length, 0);
});

test("resolved status without an answer payload does not invent a submitted custom answer", async () => {
  const value = fixtures.question();
  value.item.questions = [{ ...question, options: [], initialAnswer: "Unsubmitted proposal" }];
  const pending = deferred();
  await render("question", value);
  await input(document.querySelector("textarea"), "Locally submitted draft");
  await submit(); await act(async () => pending.resolve());
  value.request.status = "resolved";
  await render("question", value);
  assert.match(document.body.textContent, /Answered/);
  assert.doesNotMatch(document.body.textContent, /Locally submitted draft|Unsubmitted proposal/);
  assert.equal(document.querySelectorAll("input,textarea").length, 0);
});

for (const status of ["expired", "cancelled", "unavailable"] as const) test(`question ${status} never presents drafts or stale selections as submitted`, async () => {
  const value = fixtures.question();
  value.item.questions = [{ ...question, initialAnswer: "Unsubmitted proposal" }];
  await render("question", value);
  await input(document.querySelector("textarea"), "Unsubmitted local draft");
  value.request = request({ status: status === "unavailable" ? "pending" : status, answers: { choice: "first-id" },
    ...(status === "unavailable" ? { responseCapability: { type: "not_resumable" } } : {}) });
  value.item.questionAnswer = { requestId: "request-1", answers: { choice: "Unconfirmed turn answer" }, attachmentsByQuestionId: {} };
  await render("question", value);
  assert.match(document.body.textContent, new RegExp(status, "i"));
  assert.doesNotMatch(document.body.textContent, /Unsubmitted proposal|Unsubmitted local draft|Unconfirmed turn answer/);
  assert.equal(button("First").getAttribute("aria-pressed"), "false", "non-resolved card has no accepted selection");
  assert.equal(document.querySelectorAll("input,textarea").length, 0);
  assert.equal(calls.length, 0);
});

for (const status of ["saved", "declined", "cancelled"]) test(`secret ${status} has no editable or response controls`, async () => {
  const value = fixtures.secret(); value.item.secretStatus = status; await render("secret", value);
  assert.equal(document.querySelectorAll("input,button").length, 0); assert.match(document.body.textContent, new RegExp(status === "saved" ? "Saved securely" : status, "i")); assert.equal(calls.length, 0);
});

test("stale pending secret is not actionable after item cancellation", async () => {
  const value = fixtures.secret(); value.item.status = "cancelled"; await render("secret", value);
  assert.equal(document.querySelectorAll("input,button").length, 0); assert.match(document.body.textContent, /Cancelled/);
});

test("secret hides its value, locks decline while saving and retains draft on sanitized failure", async () => {
  const pending = deferred(); await render("secret"); const field = document.querySelector("input"); assert.equal(field.type, "password");
  // Generated only in memory; no submitted secret is stored in test fixtures.
  const sensitive = globalThis.crypto.randomUUID(); await input(field, sensitive);
  const decline = button("Decline"); await act(async () => { document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); decline.click(); });
  assert.equal(calls.length, 1); assert.ok(decline.disabled, "conflicting decline disabled before testing rejection");
  assert.equal(calls[0].tag, "secrets.answerRequest"); assert.equal(calls[0].payload.threadId, "thread-1"); assert.equal(calls[0].payload.turnItemId, "card-1"); assert.equal(calls[0].payload.answer.type, "save"); assert.ok(calls[0].payload.answer.secret === sensitive, "secret sent only in save RPC body");
  await act(async () => pending.reject(new Error(sensitive)));
  assert.ok(!document.body.textContent.includes(sensitive), "transport errors never expose secret"); assert.ok(!document.body.innerHTML.includes(sensitive), "secret absent from serialized markup"); assert.equal(useApp.getState().toast, null);
  assert.ok(field.value === sensitive, "failed save preserves private draft"); assert.match(document.querySelector('[role="alert"]').textContent, /Try again/);
  deferred(); await submit(); assert.equal(calls.length, 2); assert.ok(calls[1].payload.answer.secret === sensitive, "retry retains original secret");
});

test("secret acknowledgment clears private draft but waits for authoritative saved status", async () => {
  const pending = deferred(); await render("secret"); const sensitive = globalThis.crypto.randomUUID(); await input(document.querySelector("input"), sensitive); await submit();
  await act(async () => pending.resolve()); assert.match(document.body.textContent, /Waiting for confirmation/); assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].every((el) => el.disabled));
  assert.equal(document.querySelector("input").value, ""); assert.ok(!document.body.textContent.includes(sensitive));
  const value = fixtures.secret(); value.item.secretStatus = "saved"; value.item.status = "completed"; await render("secret", value); assert.match(document.body.textContent, /Saved securely/); assert.ok(!document.querySelector("input"), "no editable input");
});

for (const inFlight of [false, true]) test(`external terminal secret snapshot clears detached input ${inFlight ? "without RPC acknowledgment" : "without local submission"}`, async () => {
  const value = fixtures.secret();
  await render("secret", value);
  const field = document.querySelector("input");
  const sensitive: string = globalThis.crypto.randomUUID();
  await input(field, sensitive);
  await render("secret", structuredClone(value));
  assert.ok(document.querySelector("input") === field, "pending rerender keeps the input node");
  assert.ok(field.value === sensitive, "ordinary pending rerenders retain private typing");
  if (inFlight) { deferred(); await submit(); }
  value.item.secretStatus = "declined";
  value.item.status = "completed";
  await render("secret", value);
  assert.equal(document.querySelector("input"), null);
  assert.match(document.body.textContent, /Declined/);
  assert.ok(field.value === "", "detached input value is cleared immediately");
  assert.ok(!document.body.textContent.includes(sensitive), "private value is absent from visible text");
  assert.ok(!document.body.innerHTML.includes(sensitive), "private value is absent from serialized markup");
  assert.equal(calls.length, inFlight ? 1 : 0);
});

test("secret decline uses existing payload and cannot send twice", async () => {
  await render("secret"); const decline = button("Decline"); await act(async () => { decline.click(); decline.click(); });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], { tag: "secrets.answerRequest", payload: { threadId: "thread-1", turnItemId: "card-1", answer: { type: "decline" } } });
});

test("authoritative resolution while response is in flight stays non-actionable after rejection", async () => {
  const pending = deferred(); const value = fixtures.question(); value.request.responseCapability = { type: "message" }; await render("question", value); await click(button("First"));
  value.request = { ...value.request, status: "expired" }; await render("question", value); await act(async () => pending.reject(new Error("Already resolved")));
  assert.match(document.body.textContent, /Expired/); assert.equal(document.querySelector('[role="alert"]'), null); assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].every((el) => el.disabled));
});

test("new request identity resets drafts and an older completion cannot lock it", async () => {
  const pending = deferred(); await render("question"); await click(button("Something else")); await input(document.querySelector("input"), "Old example"); await submit();
  const value = fixtures.question(); value.id = "card-2"; value.item = { ...value.item, id: "card-2", requestId: "request-2" }; value.request = request({ id: "request-2" }); await render("question", value);
  assert.ok(!document.querySelector("input"), "no editable input"); await act(async () => pending.resolve()); assert.equal(button("First").disabled, false);
});

test("real transcript projection makes all three cards non-actionable on terminal snapshots", async () => {
  const records = [item("approval_request", { id: "approval", requestId: "approval-request", requestKind: "command" }), item("user_input_request", { id: "question", requestId: "question-request", questions: [question] }), item("secret_request", { id: "secret", status: "cancelled", secretStatus: "cancelled" })];
  const entries = buildEntries(records, { bot: { slug: "example" }, botsByThread: new Map(), tasks: [], requests: { "approval-request": request({ id: "approval-request", status: "cancelled" }), "question-request": request({ id: "question-request", status: "expired" }) } });
  for (const entry of entries) { await render(entry.kind, entry); assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input")].every((el) => el.disabled)); }
  assert.equal(calls.length, 0);
});

test("pending custom question draft survives leaving and returning to the same request", async () => {
  const value = fixtures.question();
  await render("question", value);
  await click(button("Something else"));
  await input(document.querySelector("input"), "My unfinished answer");
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.equal(document.querySelector("input")?.value, "My unfinished answer");
  assert.equal(calls.length, 0, "navigation does not submit a draft");
});

test("pending multi-select choices survive remount and can still be changed", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, multiSelect: true }];
  await render("question", value);
  await click(button("First")); await click(button("Second"));
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.equal(button("First").getAttribute("aria-pressed"), "true");
  assert.equal(button("Second").getAttribute("aria-pressed"), "true");
  await click(button("Second")); await click(button("Done"));
  assert.equal(calls.length, 1);
  assertCommand({ type: "runtime-request.respond", answers: { choice: ["first-id"] } });
});

test("pending question step and edited multiline proposal survive changing chats", async () => {
  const value = fixtures.question();
  value.item.questions = [question, { id: "detail", question: "Review detail", options: [], initialAnswer: "Original detail" }];
  await render("question", value); await click(button("Second"));
  const edited = "  My unfinished detail\n\nKeep this line  \n";
  await input(document.querySelector("textarea"), edited);
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.match(document.body.textContent, /2 of 2/);
  assert.equal(document.querySelector("textarea")?.value, edited);
  assert.equal(calls.length, 0);
  await submit();
  assertCommand({ type: "runtime-request.respond", answers: { choice: "second-id", detail: edited } });
});

test("question response ownership survives remount before and after RPC acknowledgment", async () => {
  const value = fixtures.question(); const pending = deferred();
  await render("question", value); await click(button("First"));
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.equal(button("First").disabled, true);
  await click(button("Second")); assert.equal(calls.length, 1);
  await act(async () => root.render(null));
  await act(async () => pending.resolve());
  await render("question", structuredClone(value));
  assert.match(document.body.textContent, /Waiting for confirmation/);
  assert.equal(button("First").disabled, true);
  await click(button("Second")); assert.equal(calls.length, 1);
});

test("question failure while away keeps the complete draft and allows an explicit retry", async () => {
  const value = fixtures.question(); const pending = deferred();
  await render("question", value); await click(button("Something else"));
  await input(document.querySelector("input"), "My answer to retry"); await submit();
  await act(async () => root.render(null));
  await act(async () => pending.reject(new Error("Example transport failure")));
  await render("question", structuredClone(value));
  assert.equal(document.querySelector("input")?.value, "My answer to retry");
  assert.match(document.querySelector('[role="alert"]').textContent, /Try again/);
  deferred(); await submit();
  assert.equal(calls.length, 2);
  assertCommand({ type: "runtime-request.respond", answers: { choice: "My answer to retry" } }, 1);
});

test("dismissed question is Cancelled even when the request resolution is recorded as resolved", async () => {
  const value = fixtures.question();
  value.item.status = "cancelled";
  value.request = request({ status: "resolved", decision: "cancel", responseCapability: { type: "message" } });
  await render("question", value);
  assert.match(document.body.textContent, /Cancelled/);
  assert.doesNotMatch(document.body.textContent, /Resolved|Answered/);
  assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button,input,textarea")].every((el) => el.disabled));
  assert.equal(calls.length, 0);
});

test("successful explicit question dismissal discards the custom draft but keeps the response locked", async () => {
  const value = fixtures.question(); value.request.responseCapability = { type: "message" };
  const pending = deferred(); await render("question", value);
  await click(button("Something else")); await input(document.querySelector("input"), "Discard this unfinished answer");
  await click(document.querySelector('[aria-label="Dismiss"]'));
  await act(async () => pending.resolve());
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.equal(document.querySelector("input"), null);
  assert.doesNotMatch(document.body.textContent, /Discard this unfinished answer/);
  assert.ok([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button,input,textarea")].every((el) => el.disabled));
  assert.equal(calls.length, 1);
});

for (const status of ["resolved", "expired", "cancelled"] as const) test(`an offscreen ${status} request discards its retained question draft`, async () => {
  const value = fixtures.question();
  await render("question", value); await click(button("Something else"));
  await input(document.querySelector("input"), "Old question work");
  await act(async () => root.render(null));
  await act(async () => useApp.setState({ threadData: { "thread-1": {
    loaded: true, runs: {}, items: { [value.item.id]: value.item },
    requests: { "request-1": request({ status }) },
  } } }));
  const terminal = structuredClone(value); terminal.request.status = status;
  await render("question", terminal);
  assert.doesNotMatch(document.body.textContent, /Old question work/);
  // Even a later stale pending projection cannot restore discarded local work.
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.equal(document.querySelector("input"), null);
  assert.equal(calls.length, 0);
});

test("equal request ids in different threads keep independent unfinished question drafts", async () => {
  const first = fixtures.question(); const second = structuredClone(first); second.item.threadId = "thread-2";
  await render("question", first); await click(button("Something else"));
  await input(document.querySelector("input"), "First thread answer");
  await render("question", second, "thread-2");
  assert.equal(document.querySelector("input"), null);
  await click(button("Something else")); await input(document.querySelector("input"), "Second thread answer");
  await render("question", first);
  assert.equal(document.querySelector("input")?.value, "First thread answer");
  await render("question", second, "thread-2");
  assert.equal(document.querySelector("input")?.value, "Second thread answer");
  assert.equal(calls.length, 0);
});

test("answered question has an accessible state without a visible generic status line", async () => {
  const value = fixtures.question(); value.request = request({ status: "resolved", answers: { choice: "first-id" } });
  await render("question", value);
  assert.ok(document.querySelector('[aria-label="Answered question"]'));
  assert.equal(document.querySelector(".question-terminal-status"), null);
  assert.equal(button("Second"), undefined);
  assert.equal(calls.length, 0);
});

test("Something else reveals and focuses the editor only after that user action", async () => {
  const value = fixtures.question(); await render("question", value);
  assert.equal(document.querySelector("input"), null);
  await click(button("Something else"));
  assert.equal(document.activeElement, document.querySelector("input"));
  await input(document.querySelector("input"), "A retained custom answer");
  await act(async () => root.render(null));
  await render("question", structuredClone(value));
  assert.equal(document.querySelector("input").value, "A retained custom answer");
  assert.notEqual(document.activeElement, document.querySelector("input"), "remount does not reopen the keyboard");
  assert.equal(calls.length, 0);
});

test("a proposed multiline answer never requests focus merely by mounting", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, options: [], initialAnswer: "Proposed draft" }];
  await render("question", value);
  assert.equal(document.querySelector("textarea").value, "Proposed draft");
  assert.notEqual(document.activeElement, document.querySelector("textarea"));
  assert.equal(calls.length, 0);
});

test("multi-select custom text replaces choices and uses the supported custom-string answer", async () => {
  const value = fixtures.question(); value.item.questions = [{ ...question, multiSelect: true }];
  await render("question", value); await click(button("First"));
  await click(button("Something else")); await input(document.querySelector("input"), "Use a custom sample");
  assert.equal(button("First").getAttribute("aria-pressed"), "false");
  await submit();
  assertCommand({ type: "runtime-request.respond", answers: { choice: "Use a custom sample" } });
});

test("multi-step Next requires an answer and final single-choice click submits immediately", async () => {
  const value = fixtures.question();
  value.item.questions = [{ ...question, multiSelect: true }, { ...question, id: "detail", question: "Pick the final detail" }];
  await render("question", value);
  assert.equal(button("Next").disabled, true);
  assert.equal(button("Skip"), undefined, "unsupported omission is never offered");
  await click(button("First")); assert.equal(calls.length, 0);
  await click(button("Next")); assert.equal(calls.length, 0);
  assert.equal(button("Done").disabled, true);
  await click(button("Second"));
  assert.equal(calls.length, 1);
  assertCommand({ type: "runtime-request.respond", answers: { choice: ["first-id"], detail: "second-id" } });
});

test("Back and Next retain a single selection and unfinished custom detail", async () => {
  const value = fixtures.question();
  value.item.questions = [question, { id: "detail", question: "Add detail", options: [], allowCustomAnswer: true }];
  await render("question", value); await click(button("First"));
  await click(button("Something else")); await input(document.querySelector("input"), "Keep this unfinished detail");
  await click(button("Back"));
  assert.equal(button("First").getAttribute("aria-pressed"), "true");
  assert.equal(button("Next").disabled, false);
  await click(button("Next"));
  assert.equal(document.querySelector("input").value, "Keep this unfinished detail");
  assert.equal(calls.length, 0);
  await click(button("Done"));
  assertCommand({ type: "runtime-request.respond", answers: { choice: "first-id", detail: "Keep this unfinished detail" } });
});
