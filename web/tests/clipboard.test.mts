import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOnce, domWindow, entryChunk } from "./support.mts";
import { Window } from "happy-dom";

const directory = await mkdtemp(join(tmpdir(), "bot-clipboard-"));
const bundle = await buildOnce({ configFile: false, logLevel: "silent", build: { ssr: new URL("../src/lib/t3.ts", import.meta.url).pathname, write: false } });
const entry = entryChunk(bundle);
assert.ok(entry);
const filename = join(directory, "clipboard.mjs");
await writeFile(filename, entry.code);
const { copyText } = await import(pathToFileURL(filename).href);
let window, button;
const sample = "const label = '雪 🪁';\n\treturn label;\n";

beforeEach(() => {
  window = domWindow(new Window({ url: "https://clipboard.example/" }));
  for (const name of ["window", "document", "navigator", "HTMLElement"]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? window : window[name] });
  }
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  button = document.createElement("button");
  button.textContent = "Copy code";
  document.body.append(button);
  button.focus();
});
afterEach(async () => { await window.happyDOM.close(); });
after(async () => { await rm(directory, { recursive: true }); });

const clipboard = (value) => Object.defineProperty(navigator, "clipboard", { configurable: true, value });
const execCommand = (value) => Object.defineProperty(document, "execCommand", { configurable: true, value });

test("secure clipboard copies exact Unicode, indentation and trailing newline without moving focus", async () => {
  const written = [];
  clipboard({ writeText: async (text) => { written.push(text); } });
  execCommand(() => { throw Error("Fallback must not run"); });
  await copyText(sample);
  assert.deepEqual(written, ["const label = '雪 🪁';\n\treturn label;\n"]);
  assert.equal(document.activeElement, button);
  assert.equal(document.querySelectorAll("textarea").length, 0);
});

test("secure clipboard rejection propagates instead of reporting a successful fallback", async () => {
  const denied = new Error("Clipboard denied");
  const written = [];
  clipboard({ writeText: async (text) => { written.push(text); throw denied; } });
  execCommand(() => { throw Error("Fallback must not run"); });
  await assert.rejects(copyText(sample), (error) => error === denied);
  assert.deepEqual(written, [sample]);
  assert.equal(document.activeElement, button);
  assert.equal(document.querySelectorAll("textarea").length, 0);
});

for (const insecure of [true, false]) test(`legacy copy preserves exact bytes, focus and bounded readonly input (${insecure ? "insecure context" : "missing API"})`, async () => {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: !insecure });
  clipboard(insecure ? { writeText: () => { throw Error("Insecure API must not run"); } } : undefined);
  let copied;
  execCommand((command) => {
    const input = document.querySelector("textarea");
    assert.equal(command, "copy");
    assert.ok(input);
    copied = input.value.slice(input.selectionStart, input.selectionEnd);
    assert.equal(input.readOnly, true, "temporary selection must not summon the software keyboard");
    assert.equal(input.style.position, "fixed");
    assert.equal(input.style.width, "1px");
    assert.equal(input.style.height, "1px");
    assert.equal(input.style.top, "0px");
    assert.equal(input.style.left, "0px");
    input.focus();
    return true;
  });
  await copyText(sample);
  assert.equal(copied, "const label = '雪 🪁';\n\treturn label;\n");
  assert.equal(document.activeElement, button);
  assert.equal(document.querySelectorAll("textarea").length, 0);
});

test("legacy copy refusal rejects, removes the selection input and restores focus", async () => {
  clipboard(undefined);
  let attempted;
  execCommand(() => {
    const input = document.querySelector("textarea");
    attempted = input.value;
    input.focus();
    return false;
  });
  await assert.rejects(copyText(sample), /Copy failed/);
  assert.equal(attempted, "const label = '雪 🪁';\n\treturn label;\n");
  assert.equal(document.activeElement, button);
  assert.equal(document.querySelectorAll("textarea").length, 0);
});

test("legacy copy exception still removes temporary DOM and restores focus without scrolling", async () => {
  clipboard(undefined);
  const denied = new Error("Legacy copy denied");
  let attempted;
  let restoreOptions;
  const focus = button.focus.bind(button);
  button.focus = (options) => { restoreOptions = options; focus(options); };
  execCommand(() => {
    const input = document.querySelector("textarea");
    attempted = input.value;
    input.focus();
    throw denied;
  });
  await assert.rejects(copyText(sample), (error) => error === denied);
  assert.equal(attempted, sample);
  assert.equal(document.querySelectorAll("textarea").length, 0);
  assert.equal(document.activeElement, button);
  assert.deepEqual(restoreOptions, { preventScroll: true });
});

test("unavailable legacy copy rejects without leaving a temporary input", async () => {
  clipboard(undefined);
  execCommand(undefined);
  await assert.rejects(copyText(sample), /Clipboard unavailable/);
  assert.equal(document.activeElement, button);
  assert.equal(document.querySelectorAll("textarea").length, 0);
});
