import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { build } from "vite";

// Child approvals and Force stop, with the real store and React DOM; only the T3 transport is mocked.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = new Window({ url: "http://run-controls.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = (element) => window.getComputedStyle(element);
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await build({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "run-controls-test-entry", resolveId: (id) => id.endsWith("virtual:run-controls") ? "\0run-controls" : undefined,
    load: (id) => id === "\0run-controls" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export * from ${JSON.stringify(`${src}components/RunControls.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:run-controls", write: false },
});
const dir = await mkdtemp(join(tmpdir(), "bot-run-controls-"));
const file = join(dir, "entry.mjs");
await writeFile(file, bundle.output.find((o) => o.type === "chunk" && o.isEntry).code);
const { createElement: h, act, createRoot, ChildApprovals, ForceStop, childrenAwaitingApproval, unresponsiveStop, useApp, t3 } = await import(pathToFileURL(file).href);
after(async () => { for (const c of channels) { c.port1.close(); c.port2.close(); } await window.happyDOM.close(); await rm(dir, { recursive: true, force: true }); });

const bot = { slug: "lab", name: "Lab", projectId: "project", mainThreadId: "main", shape: "blob", color: "blue" };
const shell = (id, extra = {}) => ({ id, projectId: "project", title: id, status: "running", activeRunId: null, latestRunId: null, pendingRuntimeRequest: null, archivedAt: null, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "main" }, updatedAt: "2026-11-05T00:00:00Z", ...extra });
const child = (id, kind, extra = {}) => shell(id, { title: `Helper ${id}`, pendingRuntimeRequest: kind ? { id: `${id}-request`, kind, blocking: true } : null, lineage: { parentThreadId: "main", relationshipToParent: "subagent", rootThreadId: "main" }, ...extra });
const approvalItem = (threadId) => ({ id: `${threadId}-item`, threadId, runId: "run", ordinal: 1, status: "waiting", title: "Delete the build folder", type: "approval_request", requestKind: "command", requestId: `${threadId}-request`, startedAt: null, completedAt: null, updatedAt: "2026-11-05T00:00:00Z", parentItemId: null });
const pending = (threadId) => ({ id: `${threadId}-request`, kind: "command", status: "pending", responseCapability: { type: "live", providerSessionId: "s" } });

let root, host, calls, streams;
beforeEach(() => {
  calls = []; streams = [];
  t3.call = async (tag, payload) => { calls.push({ tag, payload }); return tag === "orchestration.forceStopThread" ? { outcome: "killed", sharedWithThreadIds: [] } : { sequence: 1 }; };
  t3.dispatch = async (command) => { calls.push({ tag: "dispatch", payload: command }); return { sequence: 1 }; };
  t3.stream = (tag, payload) => { streams.push({ tag, payload }); return { cancel() {}, done: new Promise(() => {}) }; };
  useApp.setState({ bots: { lab: bot }, threads: {}, threadData: {}, runtimeFeatures: { sideChats: false, threadForceStop: true }, toast: null });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const button = (text) => [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === text);
const click = async (el) => { assert.ok(el, "control exists"); await act(async () => el.click()); };

test("only direct children waiting on an approval qualify; questions, side chats and archived children do not", () => {
  const threads = {
    main: shell("main"),
    a: child("a", "command"),
    q: child("q", "user_input"),
    auth: child("auth", "auth_refresh"),
    idle: child("idle", null),
    side: child("side", "command", { lineage: { parentThreadId: "main", relationshipToParent: "fork", rootThreadId: "main", sideChat: true } }),
    old: child("old", "command", { archivedAt: "2026-11-01T00:00:00Z" }),
    grand: child("grand", "command", { lineage: { parentThreadId: "a", relationshipToParent: "subagent", rootThreadId: "main" } }),
  };
  assert.deepEqual(childrenAwaitingApproval(threads, "main").map((t) => t.id), ["a"]);
  assert.deepEqual(childrenAwaitingApproval(threads, "a").map((t) => t.id), ["grand"]);
});

test("a child's approval shows in the parent and the answer goes to the child thread", async () => {
  useApp.setState({
    threads: { main: shell("main"), a: child("a", "command") },
    threadData: { a: { loaded: true, runs: {}, subagents: {}, items: { "a-item": approvalItem("a") }, requests: { "a-request": pending("a") } } },
  });
  await act(async () => root.render(h(ChildApprovals, { bot, threadId: "main" })));
  assert.ok(streams.some((s) => s.tag === "orchestration.subscribeThread" && s.payload.threadId === "a"), "subscribes to the child");
  assert.match(host.textContent, /From Helper a/);
  assert.match(host.textContent, /Delete the build folder/);
  await click(button("Allow once"));
  const respond = calls.find((c) => c.tag === "dispatch" && c.payload.type === "runtime-request.respond");
  assert.ok(respond);
  assert.equal(respond.payload.threadId, "a");
  assert.equal(respond.payload.requestId, "a-request");
  assert.equal(respond.payload.decision, "accept");
});

test("nothing shows once the child's approval is answered", async () => {
  useApp.setState({
    threads: { main: shell("main"), a: child("a", "command") },
    threadData: { a: { loaded: true, runs: {}, subagents: {}, items: { "a-item": { ...approvalItem("a"), status: "completed" } }, requests: { "a-request": { ...pending("a"), status: "resolved" } } } },
  });
  await act(async () => root.render(h(ChildApprovals, { bot, threadId: "main" })));
  assert.equal(host.textContent, "");
});

const stopItem = (extra = {}) => ({ id: "stop", threadId: "main", runId: "run", ordinal: 5, status: "completed", title: null, type: "run_interrupt_request", message: "Stop", startedAt: null, completedAt: null, updatedAt: "2026-11-05T00:00:00Z", parentItemId: null, ...extra });

test("Force stop appears only for an unconfirmed Stop on a run that is still going", () => {
  const running = { run: { status: "running" } };
  assert.equal(unresponsiveStop([stopItem()], running), null);
  assert.deepEqual(unresponsiveStop([stopItem({ unresponsiveAt: "2026-11-05T00:01:00Z" })], running), { runId: "run" });
  assert.equal(unresponsiveStop([stopItem({ unresponsiveAt: "2026-11-05T00:01:00Z" })], { run: { status: "interrupted" } }), null);
});

test("Force stop sends the run that ignored Stop", async () => {
  const items = [stopItem({ unresponsiveAt: "2026-11-05T00:01:00Z" })];
  useApp.setState({ threads: { main: shell("main") }, threadData: { main: { loaded: true, runs: { run: { id: "run", status: "running" } }, items: {}, requests: {}, subagents: {} } } });
  await act(async () => root.render(h(ForceStop, { threadId: "main", items, readOnly: false })));
  assert.match(host.textContent, /isn’t responding to Stop/);
  await click(button("Force stop"));
  assert.deepEqual(calls.find((c) => c.tag === "orchestration.forceStopThread")?.payload, { threadId: "main", runId: "run" });
});

test("without the T3 capability, Force stop points to T3 Code instead of offering a button", async () => {
  useApp.setState({ runtimeFeatures: { sideChats: false, threadForceStop: false }, threads: { main: shell("main") }, threadData: { main: { loaded: true, runs: { run: { id: "run", status: "running" } }, items: {}, requests: {}, subagents: {} } } });
  await act(async () => root.render(h(ForceStop, { threadId: "main", items: [stopItem({ unresponsiveAt: "2026-11-05T00:01:00Z" })], readOnly: false })));
  assert.match(host.textContent, /from T3 Code/);
  assert.equal(button("Force stop"), undefined);
});
