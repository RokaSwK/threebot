import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const chatPath = new URL("../src/components/Chat.tsx", import.meta.url).pathname;
const behaviorPath = new URL("../src/lib/chatBehavior.ts", import.meta.url).pathname;
const storePath = new URL("../src/store.ts", import.meta.url).pathname;
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "mobile-chat-test",
    resolveId: (id) => id.endsWith("virtual:mobile-chat-test") ? "\0mobile-chat-test" : undefined,
    load: (id) => id === "\0mobile-chat-test" ? `
      export { Composer, AttachmentPicker, BotBubble, AttachmentList } from ${JSON.stringify(chatPath)};
      export * from ${JSON.stringify(behaviorPath)};
      export { useApp } from ${JSON.stringify(storePath)};
      export { createElement } from "react";
      export { renderToStaticMarkup } from "react-dom/server";
    ` : undefined,
    // Exercise the real components without making their implementation public app APIs.
    transform: (code, id) => id === chatPath
      ? { code: code + "\nexport { Composer, AttachmentPicker, AttachmentList };", map: null }
      : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:mobile-chat-test", write: false },
});
const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
assert.ok(entry);
const drafts = new Map();
globalThis.localStorage = { getItem: (key) => drafts.get(key) ?? null };
globalThis.window = {};
// React's Node server renderer uses createRequire(import.meta.url), which needs a file URL.
const temporary = await mkdtemp(join(tmpdir(), "bot-mobile-chat-test-"));
let loaded;
try {
  const output = join(temporary, "chat.mjs");
  await writeFile(output, entry.code);
  loaded = await import(pathToFileURL(output).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const {
  composerFocusBehavior, MOBILE_CHAT_QUERY, splitBubbles, takeAttachmentFiles,
  Composer, AttachmentPicker, BotBubble, AttachmentList, useApp,
  createElement: h, renderToStaticMarkup: render,
} = loaded;

function textarea(readOnly) {
  return {
    readOnly, focusCalls: 0, blurCalls: 0,
    focus() { this.focusCalls++; },
    blur() { this.blurCalls++; },
  };
}

test("mobile entry, chat switches and remounts never focus the composer", () => {
  const target = textarea(true);
  for (let chat = 0; chat < 3; chat++) {
    const behavior = composerFocusBehavior(true);
    behavior.onEntry(target);
    assert.equal(target.focusCalls, 0);
    assert.equal(target.readOnly, true);
  }
});

test("mobile tapping enables editing, then overlay restoration is rejected", () => {
  const target = textarea(true);
  const behavior = composerFocusBehavior(true);
  behavior.onPointerDown(target);
  assert.equal(target.readOnly, false, "the tap enables editing before native focus");
  behavior.onFocus(target);
  assert.equal(target.blurCalls, 0);
  assert.equal(target.readOnly, false);
  behavior.onBlur(target);
  assert.equal(target.readOnly, true, "closing the keyboard rearms tap-only editing");
  behavior.onFocus(target); // Modal/BotExchange restoring previousFocus.focus().
  assert.equal(target.readOnly, true);
  assert.equal(target.blurCalls, 1);
  behavior.onPointerDown(target);
  behavior.onFocus(target);
  assert.equal(target.readOnly, false, "another explicit tap still works");
  assert.equal(target.blurCalls, 1);
});

test("a cancelled touch cannot authorize a later programmatic focus", () => {
  const target = textarea(true);
  const behavior = composerFocusBehavior(true);
  behavior.onPointerDown(target);
  behavior.onPointerCancel(target);
  assert.equal(target.readOnly, true);
  behavior.onFocus(target);
  assert.equal(target.blurCalls, 1);
});

test("scrolling inside an already active composer keeps editing enabled", () => {
  const target = textarea(true);
  const behavior = composerFocusBehavior(true);
  behavior.onPointerDown(target);
  behavior.onFocus(target);
  behavior.onPointerDown(target);
  behavior.onPointerCancel(target);
  assert.equal(target.readOnly, false);
  assert.equal(target.blurCalls, 0);
});

test("desktop entry and focus restoration stay editable", () => {
  const target = textarea(false);
  const behavior = composerFocusBehavior(false);
  behavior.onEntry(target);
  behavior.onPointerDown(target);
  behavior.onFocus(target);
  behavior.onBlur(target);
  behavior.onFocus(target);
  assert.equal(target.focusCalls, 1);
  assert.equal(target.blurCalls, 0);
  assert.equal(target.readOnly, false);
});

const bot = { slug: "example", name: "Example", mainThreadId: "main", color: "teal", shape: "blob" };
test("the real composer renders mobile tap protection while retaining each thread's draft", () => {
  drafts.set("bot.draft.example", "A saved main draft");
  drafts.set("bot.draft.child", "A saved child draft");
  const queries = [];
  globalThis.window = { matchMedia: (query) => { queries.push(query); return { matches: true }; } };
  const main = render(h(Composer, { bot, threadId: "main", working: false }));
  const child = render(h(Composer, { bot, threadId: "child", working: true }));
  assert.match(main, /<textarea[^>]*readOnly=""[^>]*>A saved main draft<\/textarea>/);
  assert.match(child, /<textarea[^>]*readOnly=""[^>]*>A saved child draft<\/textarea>/);
  assert.ok(queries.every((query) => query === MOBILE_CHAT_QUERY));
  assert.match(MOBILE_CHAT_QUERY, /max-width: 760px/);
  assert.match(MOBILE_CHAT_QUERY, /pointer: coarse/);
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const desktop = render(h(Composer, { bot, threadId: "main", working: false }));
  assert.doesNotMatch(desktop, /<textarea[^>]*readOnly/);
  assert.match(desktop, />A saved main draft<\/textarea>/);
});

function picker(mobile, open) {
  return render(h(AttachmentPicker, {
    mobile, open, onToggle() {}, onClose() {}, onFiles() {},
  }));
}
function input(markup, label) {
  return markup.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

test("mobile attachment actions render distinct native library, camera and file semantics", () => {
  const markup = picker(true, true);
  assert.equal((markup.match(/role="menuitem"/g) ?? []).length, 3);
  for (const label of ["Choose File", "Take Photo", "Photo or Video"]) {
    assert.ok(markup.includes(` ${label}</button>`), `${label} is offered in the menu`);
  }
  const library = input(markup, "Photo library");
  assert.match(library, /type="file"/);
  assert.match(library, /accept="image\/\*,video\/\*"/);
  assert.match(library, /multiple=""/);
  assert.doesNotMatch(library, /capture=/);
  const camera = input(markup, "Take photo");
  assert.match(camera, /accept="image\/\*"/);
  assert.match(camera, /capture="environment"/);
  assert.doesNotMatch(camera, /multiple=/);
  const files = input(markup, "Files");
  assert.match(files, /multiple=""/);
  assert.doesNotMatch(files, /accept=|capture=/);
});

test("closing the attachment menu leaves all native inputs mounted for picker results", () => {
  const markup = picker(true, false);
  assert.doesNotMatch(markup, /role="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  for (const label of ["Photo library", "Take photo", "Files"]) {
    assert.match(input(markup, label), /hidden=""/);
  }
});

test("desktop keeps one unrestricted multiple-file picker and Attach files action", () => {
  const markup = picker(false, true);
  assert.equal((markup.match(/<input/g) ?? []).length, 1);
  assert.equal((markup.match(/role="menuitem"/g) ?? []).length, 1);
  assert.ok(markup.includes(" Attach files</button>"));
  assert.doesNotMatch(markup, /capture=|accept=|Photo library|Take photo/);
  assert.match(input(markup, "Files"), /multiple=""/);
});

test("picker results snapshot files before reset and allow reselecting the same file", () => {
  const first = new File(["example"], "example.txt", { type: "text/plain" });
  const photo = new File(["photo"], "example.jpg", { type: "image/jpeg" });
  let nativeFiles = [first, photo];
  let nativeValue = "C:\\fakepath\\example.txt";
  const pickerInput = {
    get files() { return nativeFiles; },
    get value() { return nativeValue; },
    set value(value) { nativeValue = value; nativeFiles = []; },
  };
  const selected = takeAttachmentFiles(pickerInput);
  assert.deepEqual(selected, [first, photo]);
  assert.equal(selected[0], first);
  assert.equal(nativeValue, "");
  nativeFiles = [first];
  assert.deepEqual(takeAttachmentFiles(pickerInput), [first]);
  assert.deepEqual(takeAttachmentFiles({ files: null, value: "" }), [], "cancelling adds no files");
});

test("rich message markup preserves full URLs, code, tables, images and attachment names", () => {
  useApp.setState({ bots: {} });
  const longUrl = "https://example.test/" + "segment".repeat(100);
  const code = "wide ".repeat(150);
  const markup = render(h(BotBubble, { text: `${longUrl}\n\n\`\`\`text\n${code}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| Wide | ${"cell".repeat(100)} |\n\n![Example](https://example.test/image.png)` }));
  assert.ok(markup.includes(`href="${longUrl}"`), "long links are preserved");
  assert.ok(markup.includes(code), "wide code stays intact inside pre/code");
  assert.match(markup, /<pre><code/);
  assert.match(markup, /<table>/);
  assert.match(markup, /<img[^>]*src="https:\/\/example.test\/image.png"/);
  const attachments = render(h(AttachmentList, { attachments: [
    { id: "image", type: "image", name: "photo.jpg", previewUrl: "https://example.test/photo.jpg" },
    { id: "file", type: "file", name: "long-file-name".repeat(100) + ".pdf" },
  ] }));
  assert.match(attachments, /chat-attachments/);
  assert.match(attachments, /chat-attachment-image/);
  assert.ok(attachments.includes("long-file-name".repeat(100) + ".pdf"));
});


test("short prose still groups into bubbles, keeping introductions and lists together", () => {
  assert.deepEqual(splitBubbles("First paragraph.\n\nSecond paragraph."), ["First paragraph.", "Second paragraph."]);
  assert.deepEqual(splitBubbles("Choose one:\n\n- One\n- Two\n\nAnother thought."), ["Choose one:\n\n- One\n- Two", "Another thought."]);
  assert.deepEqual(splitBubbles("Steps\n\n1. First\n2. Second\n\nFinished."), ["Steps\n\n1. First\n2. Second", "Finished."]);
  assert.deepEqual(splitBubbles("Budget $5.\n\nRemaining $10."), ["Budget $5.", "Remaining $10."]);
  const many = "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.";
  assert.deepEqual(splitBubbles(many), [many], "long stacks keep the existing single-bubble limit");
});

test("display math and both code fence styles survive bubble grouping verbatim", () => {
  useApp.setState({ bots: {} });
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"]]) {
    const text = `Before.\n\n${open}\nx^2 +\n\ny^2\n${close}\n\nAfter.`;
    assert.deepEqual(splitBubbles(text), [text], `${open} math keeps its internal blank lines`);
    const markup = render(h(BotBubble, { text }));
    assert.equal((markup.match(/rich-math-display/g) ?? []).length, 1, `${open} reaches the real math parser intact`);
    assert.match(markup, /<math/);
    assert.ok(markup.includes("Before.") && markup.includes("After."));
    assert.deepEqual(splitBubbles(`Before.\n\n${open}\nx^2\n\ny^2`), [`Before.\n\n${open}\nx^2\n\ny^2`], "streaming math stays together before its closing delimiter arrives");
  }
  for (const fence of ["```", "~~~", "~~~~"]) {
    const code = "first line\n\nsecond line";
    const text = `Before.\n\n${fence}text\n${code}\n${fence}\n\nAfter.`;
    assert.deepEqual(splitBubbles(text), [text], `${fence} code keeps its internal blank lines`);
    const markup = render(h(BotBubble, { text }));
    assert.match(markup, /<pre><code[^>]*>first line\n\nsecond line\n<\/code><\/pre>/);
    assert.deepEqual(splitBubbles(`Before.\n\n${fence}mermaid\ngraph TD\n\nA --> B`), [`Before.\n\n${fence}mermaid\ngraph TD\n\nA --> B`], "streaming fences stay together before their closing fence arrives");
  }
});
