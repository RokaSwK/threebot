import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

// Actual ReactMarkdown, React DOM and clipboard helper. Only the browser's
// clipboard boundary and two-second status clock are controlled by these tests.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "https://markdown-code.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "markdown-code-test-entry", resolveId: (id) => id.endsWith("virtual:markdown-code-tests") ? "\0markdown-code-tests" : undefined,
    load: (id) => id === "\0markdown-code-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { default as ReactMarkdown } from "react-markdown";
      export { default as remarkGfm } from "remark-gfm";
      export { MarkdownCodeBlock } from ${JSON.stringify(`${src}components/MarkdownCodeBlock.tsx`)};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:markdown-code-tests", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const testDir = await mkdtemp(join(tmpdir(), "bot-markdown-code-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entry.code);
const { createElement: h, act, createRoot, ReactMarkdown, remarkGfm, MarkdownCodeBlock } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });

let root, host, calls, transport, timers, nextTimer;
const originalSetTimeout = window.setTimeout;
const originalClearTimeout = window.clearTimeout;
beforeEach(() => {
  calls = [];
  transport = async () => {};
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { calls.push(text); return transport(text); } } });
  timers = new Map(); nextTimer = 0;
  window.setTimeout = ((callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = (id) => { timers.delete(id); };
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.setTimeout = originalSetTimeout; window.clearTimeout = originalClearTimeout;
  document.body.replaceChildren();
});
const render = async (text) => act(async () => root.render(h(ReactMarkdown, { components: { pre: MarkdownCodeBlock }, remarkPlugins: [remarkGfm] }, text)));
const copyButton = () => document.querySelector<HTMLButtonElement>('.code-copy-button');
const copyState = () => document.querySelector<HTMLElement>('.md-code-block')?.dataset.copyState;
const click = async (button = copyButton()) => { assert.ok(button); await act(async () => button.click()); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); transport = () => promise; return { resolve, reject }; };
const settle = async (fn) => act(async () => fn());

test("ReactMarkdown distinguishes tagged fences, plain fences and inline code without a language toolbar", async () => {
  await render("An `inline` example.\n\n```js\nconst answer = 42;\n```\n\n```\nplain example\n```");
  const blocks = [...document.querySelectorAll<HTMLElement>('.md-code-block')];
  assert.deepEqual(blocks.map((block) => block.dataset.codeLanguage), ["js", ""]);
  assert.deepEqual(blocks.map((block) => block.querySelector('pre').textContent), ["const answer = 42;\n", "plain example\n"]);
  assert.equal(document.querySelector('p code').textContent, "inline");
  assert.equal(document.querySelectorAll('.code-copy-button').length, 2);
  assert.equal(blocks[0].querySelector('pre button'), null, "copy control is outside the scroller");
  assert.equal(blocks[0].querySelector('header'), null, "ordinary fences have no native file header");
  await click(blocks[0].querySelector('button')); await click(blocks[1].querySelector('button'));
  assert.deepEqual(calls, ["const answer = 42;", "plain example"]);
});

test("copy preserves tabs, Unicode, literal HTML, trailing spaces and extra terminal blank lines", async () => {
  await render('```js\n\tconst label = "λ <x> & y";  \n\n```');
  assert.equal(document.querySelector('pre code').textContent, '\tconst label = "λ <x> & y";  \n\n');
  assert.equal(document.querySelector('pre x'), null, "code is text, never executable markup");
  await click();
  assert.deepEqual(calls, ['\tconst label = "λ <x> & y";  \n']);
  assert.equal(copyButton().getAttribute('aria-label'), "Copied");
});

test("pending copy suppresses same-turn duplicate clicks and waits for clipboard confirmation", async () => {
  const pending = deferred(); await render("```js\nexample();\n```");
  const button = copyButton(); button.focus();
  await act(async () => { button.click(); button.click(); });
  assert.deepEqual(calls, ["example();"]);
  assert.equal(copyState(), "copying");
  assert.equal(button.getAttribute('aria-label'), "Copying…");
  assert.equal(button.getAttribute('aria-disabled'), "true");
  assert.equal(button.disabled, false, "pending feedback must keep keyboard focus on the copy control");
  assert.doesNotMatch(document.body.textContent, /Code copied/);
  assert.equal(document.activeElement, button);
  await settle(() => pending.resolve());
  assert.equal(copyState(), "copied");
  assert.equal(button.getAttribute('aria-disabled'), "false");
  assert.equal(button.getAttribute('aria-label'), "Copied");
  assert.equal(document.querySelector('[role=status]').textContent, "Code copied.");
  assert.equal(document.activeElement, button);
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [2000]);
  await act(async () => { for (const { callback } of timers.values()) callback(); timers.clear(); });
  assert.equal(copyState(), "idle");
  assert.equal(button.getAttribute('aria-label'), "Copy code");
});

test("clipboard rejection displays generic feedback and retry copies the same payload", async () => {
  const pending = deferred(); await render("```\n  retry λ  \n```"); await click();
  await settle(() => pending.reject(new Error("Platform error with confidential clipboard detail")));
  assert.equal(copyState(), "error");
  assert.equal(document.querySelector('[role=alert]').textContent, "Couldn't copy code. Try again.");
  assert.doesNotMatch(document.body.innerHTML, /confidential|Platform error/);
  assert.equal(copyButton().getAttribute('aria-disabled'), "false");
  transport = async () => {};
  await click();
  assert.deepEqual(calls, ["  retry λ  ", "  retry λ  "]);
  assert.equal(copyState(), "copied");
  assert.equal(document.querySelector('[role=alert]'), null);
});

test("replaced code invalidates an older pending success without unlocking a newer copy", async () => {
  const old = deferred(); await render("```js\nold();\n```"); await click();
  await render("```js\nnew();\n```");
  assert.equal(copyState(), "idle");
  assert.equal(copyButton().getAttribute('aria-disabled'), "false");
  const current = deferred(); await click();
  await settle(() => old.resolve());
  assert.deepEqual(calls, ["old();", "new();"]);
  assert.equal(copyState(), "copying");
  assert.equal(copyButton().getAttribute('aria-disabled'), "true");
  await settle(() => current.resolve());
  assert.equal(copyState(), "copied");
});

test("replaced code discards stale failures and clears prior success/reset timers", async () => {
  const old = deferred(); await render("```js\nold();\n```"); await click();
  await render("```js\nnew();\n```");
  await settle(() => old.reject(new Error("old clipboard failure")));
  assert.equal(copyState(), "idle"); assert.equal(document.querySelector('[role=alert]'), null);
  transport = async () => {}; await click();
  assert.equal(copyState(), "copied"); assert.equal(timers.size, 1);
  await render("```js\nthird();\n```");
  assert.equal(copyState(), "idle"); assert.equal(timers.size, 0);
  assert.deepEqual(calls, ["old();", "new();"]);
});

test("unrelated Markdown rerenders preserve the pending operation for identical code", async () => {
  const pending = deferred(); await render("Before.\n\n```js\nstable();\n```"); await click();
  await render("Changed surrounding prose.\n\n```js\nstable();\n```");
  assert.equal(copyState(), "copying"); assert.equal(copyButton().getAttribute('aria-disabled'), "true");
  await settle(() => pending.resolve());
  assert.equal(copyState(), "copied"); assert.deepEqual(calls, ["stable();"]);
});

test("unmount invalidates pending work and clears success timers", async () => {
  const pending = deferred(); await render("```js\nfirst();\n```"); await click();
  await act(async () => root.render(null));
  await settle(() => pending.reject(new Error("late clipboard rejection")));
  assert.equal(document.body.textContent, ""); assert.equal(timers.size, 0);
  transport = async () => {}; await render("```js\nsecond();\n```");
  assert.equal(copyState(), "idle"); await click(); assert.equal(timers.size, 1);
  await act(async () => root.render(null)); assert.equal(timers.size, 0);
  assert.deepEqual(calls, ["first();", "second();"]);
});

test("empty fences have no copy action and inline code never gets one", async () => {
  await render("Just `inline λ` and an empty fence.\n\n```js\n```");
  assert.equal(document.querySelector('p code').textContent, "inline λ");
  assert.equal(document.querySelector('.md-code-block pre').textContent, "");
  assert.equal(document.querySelector('.code-copy-button'), null);
  assert.deepEqual(calls, []);
  await render("```\n \n```"); await click(); assert.deepEqual(calls, [" "]);
});
