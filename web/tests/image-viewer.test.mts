import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk } from "./support.mts";

// The real chat image thumbnails, attachment tiles, gallery and viewer in React DOM. T3's signing RPC and the
// browser's new tab and downloads are the external boundaries.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: "https://image-viewer.test/chat", settings: { navigation: { disableChildFrameNavigation: true }, enableImageFileLoading: false } }));
for (const key of ["window", "document", "navigator", "history", "location", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent", "IntersectionObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "image-viewer-test", resolveId: (id) => id.endsWith("virtual:image-viewer") ? "\0image-viewer" : undefined,
    load: (id) => id === "\0image-viewer" ? `
      export { createElement, act, StrictMode } from "react";
      export { createRoot } from "react-dom/client";
      export { MessageImages } from ${JSON.stringify(src + "components/ImageViewer.tsx")};
      export { WorkspaceFileContext, WorkspaceMessageImage, WorkspaceResourceViewer } from ${JSON.stringify(src + "components/WorkspaceResource.tsx")};
      export { ChatAttachmentList } from ${JSON.stringify(src + "components/ChatAttachments.tsx")};
      export { t3 } from ${JSON.stringify(src + "lib/t3.ts")};` : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:image-viewer", write: false },
});
const directory = await mkdtemp(join(tmpdir(), "bot-image-viewer-"));
const filename = join(directory, "components.mjs"); await writeFile(filename, entryChunk(bundle).code);
const { createElement: h, act, StrictMode, createRoot, MessageImages, WorkspaceFileContext, WorkspaceMessageImage, WorkspaceResourceViewer, ChatAttachmentList, t3 } = await import(pathToFileURL(filename).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });

let root, host, calls, downloads, tabs;
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const button = (label) => [...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label);
const viewer = () => document.querySelector<HTMLElement>(".image-viewer");
const shown = () => ({ count: viewer().querySelector(".image-viewer-count").textContent, caption: viewer().querySelector(".image-viewer-caption")?.textContent ?? null, src: viewer().querySelector("img")?.getAttribute("src") ?? null });
const click = async (label) => { const element = button(label); assert.ok(element, label + " exists"); await act(async () => { element.click(); await flush(); }); };
const key = async (name) => act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true })); await flush(); });
const pointer = async (target, type, x, y = 100, pointerId = 1) => act(async () => { target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId, button: 0, isPrimary: pointerId === 1 })); await flush(); });
const tap = async (target, x = 100) => { await pointer(target, "pointerdown", x); await pointer(target, "pointerup", x); };
const workspace = { workspaceRoot: "/workspace/bots/example", threadId: "main", openFile() {} };
// One message: an attached photo, then a Bot-posted workspace image and a remote image in its text.
const message = () => h(MessageImages, null,
  h(ChatAttachmentList, { attachments: [{ id: "photo", type: "image", name: "photo.png", mimeType: "image/png", sizeBytes: 512 }] }),
  h(WorkspaceFileContext, { value: workspace }, h("p", null,
    h(WorkspaceMessageImage, { src: "charts/weekly.png", alt: "Weekly chart" }), " and ",
    h(WorkspaceMessageImage, { src: "https://example.com/remote.png", alt: "Remote picture" }))));
const render = async (node) => act(async () => { root.render(node); await flush(); });

beforeEach(() => {
  calls = []; downloads = []; tabs = [];
  t3.call = async (tag, payload) => { assert.equal(tag, "assets.createUrl"); calls.push(payload.resource); return { relativeUrl: `/assets/signed-${calls.length}` }; };
  mock.method(window.HTMLAnchorElement.prototype, "click", function () { downloads.push({ href: this.getAttribute("href"), filename: this.download }); });
  mock.method(window, "open", (url) => { const tab = { url, opener: {}, location: { href: url }, closed: false, close() { this.closed = true; } }; tabs.push(tab); return tab; });
  history.replaceState({ view: "chat", slug: "example", threadId: "main" }, "", "/chat");
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); await flush(); document.body.replaceChildren(); mock.restoreAll(); });

test("chat images are labelled thumbnail buttons; text and links around them are untouched", async () => {
  await render(message());
  const chart = button("Open image: Weekly chart");
  assert.equal(chart.tagName, "BUTTON");
  assert.equal(chart.type, "button");
  assert.ok(chart.classList.contains("chat-inline-image"));
  assert.equal(chart.querySelector("img").getAttribute("src"), "/t3/assets/signed-2");
  assert.equal(chart.querySelector("img").alt, "Weekly chart");
  assert.equal(button("Open image: Remote picture").querySelector("img").getAttribute("src"), "https://example.com/remote.png");
  assert.equal(host.querySelector("p").textContent, " and ");
});

test("tapping an image opens it full size, signed afresh, with its alt text as the caption", async () => {
  await render(message());
  const before = history.length;
  await click("Open image: Weekly chart");
  assert.equal(viewer().getAttribute("role"), "dialog");
  assert.equal(viewer().getAttribute("aria-modal"), "true");
  assert.deepEqual(shown(), { count: "2 / 3", caption: "Weekly chart", src: "/t3/assets/signed-3" });
  assert.deepEqual(calls.at(-1), { _tag: "workspace-file", threadId: "main", path: "charts/weekly.png" });
  assert.equal(history.length, before + 1, "the viewer owns one history entry");
  assert.equal(history.state.view, "chat", "the entry keeps the chat route");
  assert.equal(document.activeElement, button("Close"));
});

test("arrow keys, the arrow buttons and swipes move between the message's images in order", async () => {
  await render(message());
  await click("Open image: Weekly chart");
  await key("ArrowRight");
  assert.deepEqual(shown(), { count: "3 / 3", caption: "Remote picture", src: "https://example.com/remote.png" });
  await key("ArrowRight");
  assert.equal(shown().count, "1 / 3", "it wraps around");
  assert.equal(shown().caption, "photo.png");
  assert.deepEqual(calls.at(-1), { _tag: "attachment", attachmentId: "photo", disposition: "inline" });
  await key("ArrowLeft");
  assert.equal(shown().count, "3 / 3");
  await click("Previous image");
  assert.equal(shown().count, "2 / 3");
  await click("Next image");
  assert.equal(shown().count, "3 / 3");
  const stage = viewer().querySelector(".image-viewer-stage");
  await pointer(stage, "pointerdown", 300); await pointer(stage, "pointermove", 220); await pointer(stage, "pointerup", 180);
  assert.equal(shown().count, "1 / 3", "a left swipe shows the next image");
  await pointer(stage, "pointerdown", 100); await pointer(stage, "pointermove", 200); await pointer(stage, "pointerup", 240);
  assert.equal(shown().count, "3 / 3", "a right swipe shows the previous image");
  assert.ok(viewer(), "a swipe does not close the viewer");
});

test("an attached image joins the gallery from its tile", async () => {
  await render(message());
  await click("Open photo.png");
  assert.deepEqual(shown(), { count: "1 / 3", caption: "photo.png", src: "/t3/assets/signed-3" });
});

const closes: [string, () => Promise<unknown>][] = [
  ["Esc", () => key("Escape")],
  ["the ✕ button", () => click("Close")],
  ["a tap on the backdrop", () => tap(viewer().querySelector(".image-viewer-stage"))],
  ["the back gesture", () => act(async () => { history.back(); await flush(); })],
];
for (const [name, close] of closes) test(`${name} closes the viewer, pops its history entry and returns focus`, async () => {
  await render(message());
  const thumbnail = button("Open image: Weekly chart");
  thumbnail.focus();
  await click("Open image: Weekly chart");
  assert.ok(history.state.imageViewer);
  await close();
  assert.equal(viewer(), null);
  assert.deepEqual(history.state, { view: "chat", slug: "example", threadId: "main" }, "back to the chat's own entry, not out of the chat");
  assert.equal(document.activeElement, thumbnail);
  await act(async () => { history.back(); await flush(); });
  assert.equal(viewer(), null, "a later Back does not reopen it");
});

test("a tap on the image itself does not close it, and a double tap zooms in and back out", async () => {
  await render(message());
  await click("Open image: Weekly chart");
  const image = viewer().querySelector("img");
  await tap(image);
  assert.ok(viewer());
  await tap(image);
  assert.match(image.style.transform, /scale\(2\.5\)/);
  assert.ok(viewer().querySelector("[data-zoomed]"));
  await tap(image); await tap(image);
  assert.match(image.style.transform, /scale\(1\)/);
});

test("wheel and pinch zoom; a zoomed drag pans instead of swiping", async () => {
  await render(message());
  await click("Open image: Weekly chart");
  const stage = viewer().querySelector(".image-viewer-stage");
  const image = viewer().querySelector("img");
  await act(async () => { stage.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -500, clientX: 0, clientY: 0, bubbles: true, cancelable: true })); await flush(); });
  assert.match(image.style.transform, /scale\(2\.71/);
  await act(async () => { stage.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 2000, clientX: 0, clientY: 0, bubbles: true, cancelable: true })); await flush(); });
  assert.match(image.style.transform, /scale\(1\)/, "zoom stops at fit");
  await pointer(stage, "pointerdown", 100, 100, 1); await pointer(stage, "pointerdown", 200, 100, 2);
  await pointer(stage, "pointermove", 50, 100, 1); await pointer(stage, "pointermove", 250, 100, 2);
  assert.match(image.style.transform, /scale\(2\)/, "spreading two fingers to twice the distance doubles the size");
  await pointer(stage, "pointerup", 50, 100, 1); await pointer(stage, "pointerup", 250, 100, 2);
  await pointer(stage, "pointerdown", 300); await pointer(stage, "pointermove", 150); await pointer(stage, "pointerup", 150);
  assert.equal(shown().count, "2 / 3", "dragging a zoomed image does not change images");
});

test("Open original and Download sign a fresh URL each time", async () => {
  await render(message());
  await click("Open image: Weekly chart");
  const signed = calls.length;
  await click("Open original");
  assert.equal(calls.length, signed + 1);
  assert.equal(tabs[0].location.href, `/t3/assets/signed-${signed + 1}`);
  assert.equal(tabs[0].opener, null);
  await click("Download");
  assert.deepEqual(downloads, [{ href: `/t3/assets/signed-${signed + 2}`, filename: "weekly.png" }]);
  await key("ArrowRight");
  await click("Open original");
  assert.equal(tabs.at(-1).url, "https://example.com/remote.png", "a remote image opens its own URL");
  assert.equal(button("Download"), undefined, "remote images have no signed download");
  await key("ArrowRight");
  await click("Download");
  assert.deepEqual(calls.at(-1), { _tag: "attachment", attachmentId: "photo", disposition: "attachment" });
  assert.equal(downloads.at(-1).filename, "photo.png");
});

test("a failed signing shows a retry and closing still works", async () => {
  await render(message());
  t3.call = async () => { throw new Error("expired"); };
  await click("Open image: Weekly chart");
  assert.match(viewer().querySelector('[role="alert"]').textContent, /Couldn't open this image/);
  await key("Escape");
  assert.equal(viewer(), null);
});

test("the Library and file viewer open images in the same viewer, and StrictMode keeps one history entry", async () => {
  const before = history.length;
  let closed = 0;
  await render(h(StrictMode, null, h(WorkspaceResourceViewer, { resource: { _tag: "workspace-file", threadId: "main", path: "library/photo.svg" }, title: "photo.svg", onClose() { closed++; } })));
  await flush();
  assert.ok(viewer());
  assert.equal(shown().caption, "photo.svg");
  assert.equal(history.length, before + 1);
  assert.equal(closed, 0, "StrictMode's effect replay does not close it");
  await key("Escape");
  assert.equal(closed, 1);
  assert.equal(history.state.imageViewer, undefined);
});
