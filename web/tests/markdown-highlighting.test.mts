import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow } from "./support.mts";
import { installWorkers, loadWorkerHighlighter } from "./highlight-worker-fixture.mts";

// Real ReactMarkdown, React DOM, Shiki and clipboard helper. A test-only module
// gate controls when the actual highlighter settles, including rejected imports.
// DOM identity/offset checks here do not stand in for real browser geometry.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "https://markdown-highlighting.test" }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const workers = installWorkers();
const actualHighlighter = await loadWorkerHighlighter();
globalThis.actualHighlightCode = actualHighlighter.highlightCode;
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "markdown-highlight-test-entry", enforce: "pre",
    resolveId(id, importer) {
      if (id.endsWith("virtual:markdown-highlighting-tests")) return "\0markdown-highlighting-tests";
      if (id === "../lib/highlightCode" && importer?.endsWith("MarkdownCodeBlock.tsx")) return "\0controlled-highlighting";
    },
    load(id) {
      if (id === "\0controlled-highlighting") return `
        export const highlightCode = (source, tag, signal) => globalThis.highlightRequest(source, tag, globalThis.actualHighlightCode, signal);`;
      if (id === "\0markdown-highlighting-tests") return `
        export { createElement, act, StrictMode } from "react";
        export { createRoot } from "react-dom/client";
        export { default as ReactMarkdown } from "react-markdown";
        export { default as remarkGfm } from "remark-gfm";
        export { MarkdownCodeBlock } from ${JSON.stringify(src + "components/MarkdownCodeBlock.tsx")};`;
    },
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:markdown-highlighting-tests", write: false, rollupOptions: { output: { entryFileNames: "entry.mjs", chunkFileNames: "[name]-[hash].mjs" } } },
});
const directory = await mkdtemp(join(tmpdir(), "bot-markdown-highlighting-"));
for (const output of bundle.output) {
  const filename = join(directory, output.fileName);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, output.type === "chunk" ? output.code : output.source);
}
const { createElement: h, act, createRoot, StrictMode, ReactMarkdown, remarkGfm, MarkdownCodeBlock } = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const stylesheet = document.createElement("style");
stylesheet.textContent = await readFile(src + "components/MarkdownCodeBlock.css", "utf8");
document.head.append(stylesheet);
after(async () => {
  delete globalThis.highlightRequest; delete globalThis.actualHighlightCode;
  await workers.close(); await actualHighlighter.close();
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await window.happyDOM.close(); await rm(directory, { recursive: true });
});

let root, host, requests, copies, clipboard;
beforeEach(() => {
  requests = []; copies = []; clipboard = async () => {};
  globalThis.highlightRequest = (source, tag, actual, signal) => new Promise((resolve, reject) => requests.push({ source, tag, actual, signal, resolve, reject }));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { copies.push(text); return clipboard(text); } } });
  host = document.createElement("main"); host.className = "md";
  document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); document.documentElement.classList.remove("dark");
});
const render = (text, strict = false) => act(async () => {
  const markdown = h(ReactMarkdown, { components: { pre: MarkdownCodeBlock }, remarkPlugins: [remarkGfm] }, text);
  root.render(strict ? h(StrictMode, null, markdown) : markdown);
});
const fence = (source, tag = "js") => `\`\`\`${tag}\n${source}\`\`\``;
const pre = () => host.querySelector("pre");
const code = () => host.querySelector("pre code");
const button = () => host.querySelector(".code-copy-button");
const tokens = () => [...host.querySelectorAll(".code-token")];
const copy = () => act(async () => button().click());
const complete = (request = requests.at(-1)) => act(async () => request.resolve(await request.actual(request.source, request.tag)));
const fail = (request = requests.at(-1)) => act(async () => request.reject(new Error("private loader detail")));
const token = (text) => tokens().find((element) => element.textContent === text);
const identity = () => ({ pre: pre(), code: code(), button: button() });
function assertStable(original, text, scrollLeft = 137) {
  assert.equal(pre(), original.pre);
  assert.equal(code(), original.code);
  assert.equal(button(), original.button);
  assert.equal(pre().textContent, text);
  assert.equal(code().textContent, text);
  assert.equal(pre().scrollLeft, scrollLeft);
  assert.equal(document.activeElement, original.button);
}

test("delayed real tokens preserve exact Copy bytes, focused control and pre/code scroll nodes", async () => {
  const source = '\tconst λ = "<img src=x onerror=alert(1)> 雪 🪁";  \n\n';
  await render(fence(source));
  assert.equal(pre().textContent, source); assert.equal(tokens().length, 0);
  const original = identity(); pre().scrollLeft = 137; button().focus();
  let finishCopy;
  clipboard = () => new Promise((resolve) => { finishCopy = resolve; });
  await act(async () => { button().click(); button().click(); });
  assert.deepEqual(copies, [source.slice(0, -1)]);
  assert.equal(button().getAttribute("aria-disabled"), "true");
  await complete();
  assert.equal(token("const").style.getPropertyValue("--code-light"), "#D73A49");
  assert.equal(token("const").style.getPropertyValue("--code-dark"), "#F97583");
  assert.equal(host.querySelector("pre img"), null);
  assertStable(original, source);
  assert.equal(button().getAttribute("aria-label"), "Copying…");
  assert.equal(button().disabled, false);
  await act(async () => finishCopy());
  assert.equal(button().getAttribute("aria-label"), "Copied");
  assertStable(original, source);
  await copy();
  assert.deepEqual(copies, [source.slice(0, -1), source.slice(0, -1)]);
  await act(async () => finishCopy());
});

test("theme changes use real token colors without loading, retokenizing, replacing nodes or disturbing Copy", async () => {
  const source = 'const answer = "雪";\n';
  await render(fence(source)); await complete();
  const original = identity(), keyword = token("const");
  pre().scrollLeft = 137; button().focus();
  const light = window.getComputedStyle(keyword).color;
  assert.equal(light, "#D73A49");
  document.documentElement.classList.add("dark");
  // happy-dom caches descendant selector matches after ancestor class changes.
  // Dirty a harmless test attribute to recompute the real stylesheet cascade;
  // root will verify live class switching in Chrome.
  keyword.setAttribute("data-style-probe", "dark");
  assert.equal(window.getComputedStyle(keyword).color, "#F97583");
  assertStable(original, source); assert.equal(token("const"), keyword);
  await render("Changed surrounding prose.\n\n" + fence(source));
  assertStable(original, source); assert.equal(requests.length, 1);
  assert.equal(window.getComputedStyle(keyword).color, "#F97583");
  await copy(); assert.deepEqual(copies, ['const answer = "雪";']);
  document.documentElement.classList.remove("dark");
  keyword.setAttribute("data-style-probe", "light");
  assert.equal(window.getComputedStyle(keyword).color, light);
  assert.equal(button().getAttribute("aria-label"), "Copied"); assertStable(original, source);
});

test("streamed replacements render plain immediately and ignore out-of-order highlights", async () => {
  await render(fence("const first = 1;\n")); const first = requests[0];
  const original = identity(); pre().scrollLeft = 137; button().focus();
  await render(fence("const second = 2;\n")); const second = requests[1];
  assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, false);
  await complete(first);
  assertStable(original, "const second = 2;\n"); assert.equal(tokens().length, 0);
  await complete(second);
  assert.equal(token("const").style.getPropertyValue("--code-light"), "#D73A49");
  await render(fence("const third = `stream\n"));
  assertStable(original, "const third = `stream\n"); assert.equal(tokens().length, 0);
  await complete();
  assert.equal(token("const").style.getPropertyValue("--code-dark"), "#F97583");
  await copy(); assert.deepEqual(copies, ["const third = `stream"]);
});

test("language-only changes discard old colors while preserving the DOM and payload", async () => {
  const source = "const answer = 42;\n";
  await render(fence(source)); const previous = requests[0];
  await complete(previous);
  const original = identity(); pre().scrollLeft = 137; button().focus();
  await render(fence(source, "unknown-language"));
  assert.equal(tokens().length, 0); assertStable(original, source);
  await complete(); await complete(previous);
  assert.equal(tokens().length, 0); assertStable(original, source);
  await copy(); assert.deepEqual(copies, ["const answer = 42;"]);
});

test("delayed highlighting failure stays plain, focused, scrollable and copyable without diagnostics", async () => {
  const source = "const answer = 42;  \n\n";
  await render(fence(source));
  const original = identity(); pre().scrollLeft = 137; button().focus();
  await fail();
  assertStable(original, source); assert.equal(tokens().length, 0);
  assert.doesNotMatch(host.textContent, /loader|highlight|private|retry/i);
  await copy(); assert.deepEqual(copies, [source.slice(0, -1)]);
  assert.equal(button().getAttribute("aria-label"), "Copied");
  await render(fence("const retry = true;\n")); await complete();
  assert.equal(token("const").style.getPropertyValue("--code-light"), "#D73A49");
  assertStable(original, "const retry = true;\n");
});

test("older failures and unmounted success cannot replace newer content", async () => {
  await render(fence("const old = 1;\n")); const old = requests[0];
  await render(fence("const current = 2;\n")); await complete();
  await fail(old);
  assert.equal(code().textContent, "const current = 2;\n");
  assert.equal(token("const").style.getPropertyValue("--code-light"), "#D73A49");
  await render(fence("const gone = 3;\n")); const gone = requests.at(-1);
  await act(async () => root.render(null)); assert.equal(gone.signal.aborted, true); await complete(gone);
  assert.equal(host.textContent, "");
  await render(fence("const fresh = 4;\n"));
  assert.equal(tokens().length, 0); assert.equal(code().textContent, "const fresh = 4;\n");
  await complete(); await copy(); assert.deepEqual(copies, ["const fresh = 4;"]);
});

test("plain/unsupported/large blocks remain exact, empty fences and inline code get no extra controls", async () => {
  await render("An `inline` example.\n\n" + fence("", "js"));
  assert.equal(host.querySelector("p code").textContent, "inline");
  assert.equal(code().textContent, ""); assert.equal(button(), null); assert.equal(requests.length, 0);
  for (const [source, tag] of [["plain <x>\n\n", ""], ["unknown <x>\n", "no-such-language"], ["x".repeat(20_001) + "\n", "js"]]) {
    await render(fence(source, tag));
    assert.equal(code().textContent, source); assert.equal(tokens().length, 0);
    await complete(); assert.equal(tokens().length, 0); assert.equal(code().textContent, source);
    await copy(); assert.equal(copies.at(-1), source.slice(0, -1));
    assert.equal(host.querySelector("header"), null); assert.equal(pre().querySelector("button"), null);
  }
});

test("StrictMode effect cleanup ignores its first completion and keeps current highlighting and Copy", async () => {
  await render(fence("const strict = 42;\n"), true);
  assert.equal(requests.length, 2);
  await complete(requests[0]); assert.equal(tokens().length, 0);
  await complete(requests[1]);
  assert.equal(token("const").style.getPropertyValue("--code-light"), "#D73A49");
  await copy(); assert.deepEqual(copies, ["const strict = 42;"]);
});

test("ungated production worker colors current shell code while preserving focused Copy and scroll nodes", async () => {
  let completion;
  globalThis.highlightRequest = (source, tag, actual, signal) => { completion = actual(source, tag, signal); return completion; };
  const source = 'echo "雪 🪁"  \n\n';
  await render(fence('echo "old"\n', "bash"));
  const original = identity(); pre().scrollLeft = 137; button().focus();
  await render(fence(source, "bash"));
  await act(async () => { await completion; });
  assert.equal(token("echo").style.getPropertyValue("--code-light"), "#005CC5");
  assert.equal(token("echo").style.getPropertyValue("--code-dark"), "#79B8FF");
  assert.equal(tokens().find((element) => element.textContent === '"雪 🪁"').style.getPropertyValue("--code-light"), "#032F62");
  assertStable(original, source);
  await copy(); assert.deepEqual(copies, [source.slice(0, -1)]);
  assertStable(original, source);
});
