import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "vite";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "object-avatars-test-entry",
    resolveId: (id) => id.endsWith("virtual:object-avatars-test") ? "\0object-avatars-test" : undefined,
    load: (id) => id === "\0object-avatars-test" ? `export * from ${JSON.stringify(`${src}lib/objectAvatars.ts`)}; export * from ${JSON.stringify(`${src}lib/avatarDrawing.ts`)}; export { sideChatsOf } from ${JSON.stringify(`${src}lib/sideChats.ts`)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:object-avatars-test", write: false },
});
const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
assert.ok(entry, "test bundle has an entry point");
const { drawingDescription, drawingOf, drawingPending, drawingPrompt, drawingResult, drawingTitle, importDefinition, isAvatarDrawing, isObjectShape, OBJECT_AVATARS, objectDefinition, objectMood, objectShape, parseDrawing, safeDefinition, sideChatsOf } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

const fox = { version: 1, id: "fox", name: "Fox", body: { path: "M20 20 H80 V80 H20 Z" }, eyes: { x: 50, y: 46, spacing: 15, scale: 1 } };

test("shapes name objects without touching engine shapes", () => {
  assert.equal(objectShape("ghost"), "object:ghost");
  assert.equal(isObjectShape("object:ghost"), true);
  assert.equal(isObjectShape("ball"), false);
  assert.equal(OBJECT_AVATARS.length, 22);
});

test("the gallery wins, a Bot's own object resolves, and a bad one doesn't", () => {
  const ghost = objectDefinition("object:ghost", [{ shape: "object:ghost", avatarDefinition: fox }]);
  assert.equal(ghost.name, "Ghost");
  assert.equal(objectDefinition("object:fox", [{ shape: "object:fox", avatarDefinition: fox }]).id, "fox");
  assert.equal(objectDefinition("object:fox", [{ shape: "object:fox", avatarDefinition: { ...fox, extra: true } }]), null);
  assert.equal(objectDefinition("object:fox", []), null);
});

test("only rebuilt definitions reach the renderer", () => {
  const value = { ...fox, body: { path: "m20 20 h60 v60 h-60 z" } };
  assert.match(safeDefinition(value).body.path, /^M/);
  assert.equal(safeDefinition(value), safeDefinition(value), "a definition is only checked once");
  assert.equal(safeDefinition({ ...fox, body: { path: 'M20 20 H80 V80 H20 Z"/><img src=x onerror=alert(1)>' } }), null);
  assert.equal(safeDefinition({ ...fox, name: "<img src=x>" }), null);
  assert.equal(safeDefinition("<svg>"), null);
  assert.equal(safeDefinition(null), null);
});

test("imports get their own id and a readable error", () => {
  const imported = importDefinition(JSON.stringify(fox));
  assert.equal(imported.ok, true);
  assert.match(imported.definition.id, /^own-/);
  assert.equal(importDefinition(JSON.stringify({ ...fox, body: { path: fox.body.path.replace("H80", "H70") } })).definition.id === imported.definition.id, false);
  assert.deepEqual(importDefinition("nope"), { ok: false, error: "That isn't valid JSON." });
  assert.equal(importDefinition("{}").ok, false);
});

test("states map to the renderer's three moods", () => {
  assert.equal(objectMood("idle"), "idle");
  assert.equal(objectMood("working"), "thinking");
  assert.equal(objectMood("waiting"), "thinking");
  assert.equal(objectMood("celebrate"), "happy");
  assert.equal(objectMood("failed"), "idle");
});

const side = (patch = {}) => ({ id: "s", title: "Side", status: "idle", activeRunId: null, latestRunId: "r1", latestRunCompletedAt: "2026-11-06T10:00:01Z", pendingRuntimeRequest: null, archivedAt: null,
  createdAt: "2026-11-06T10:00:00Z", updatedAt: "2026-11-06T10:00:00Z", lineage: { parentThreadId: "main", relationshipToParent: "fork", rootThreadId: "main", sideChat: true }, ...patch });
const reply = (text) => ({ type: "assistant_message", text });

test("a drawing is a side chat that side chat lists leave out", () => {
  const drawing = side({ id: "d", title: drawingTitle("a fox with a scarf") });
  const threads = { d: drawing, s: side(), older: side({ id: "older", title: drawingTitle("an owl"), createdAt: "2026-11-05T00:00:00Z" }) };
  assert.equal(isAvatarDrawing(drawing), true);
  assert.equal(isAvatarDrawing(side()), false);
  assert.deepEqual(sideChatsOf(threads, "main").map((t) => t.id), ["s"]);
  assert.equal(drawingOf(threads, "main").id, "d");
  assert.equal(drawingOf(threads, "other"), undefined);
  const long = `a fox with ${"a very long striped scarf, ".repeat(6)}and boots`;
  assert.equal(drawingDescription(side({ title: drawingTitle(` ${long}\n`) })), long, "Try again asks for the whole description");
});

test("the drawing prompt keeps the Bot's avatar rules and leaves its files alone", () => {
  const prompt = drawingPrompt("  a fox with a scarf ");
  assert.match(prompt, /a fox with a scarf\./);
  assert.match(prompt, /avatar drawing rules in your instructions/);
  assert.match(prompt, /Don't edit `\.bot\/bot\.json`/);
  assert.match(prompt, /```json/);
});

test("a reply becomes a validated definition, or says why not", () => {
  const ok = parseDrawing("Here it is:\n\n```json\n" + JSON.stringify(fox) + "\n```");
  assert.equal(ok.ok, true);
  assert.match(ok.definition.id, /^own-/);
  assert.equal(parseDrawing(JSON.stringify({ shape: "object:fox", avatarDefinition: fox })).ok, true, "a whole bot.json still counts");
  assert.equal(parseDrawing("bare " + JSON.stringify(fox) + " json").ok, true);
  assert.deepEqual(parseDrawing("I couldn't do it."), { ok: false, error: "The reply had no avatar in it." });
  const empty = parseDrawing("```json\n" + JSON.stringify({ ...fox, body: { path: "" } }) + "\n```");
  assert.equal(empty.ok, false);
  assert.match(empty.error, /didn't validate: body\.path: path is empty/);
  assert.equal(parseDrawing("```json\n" + JSON.stringify({ ...fox, body: { path: 'M0 0"/><img src=x onerror=alert(1)>' } }) + "\n```").ok, false);
});

test("a drawing is pending until its run finishes, then shows its result", () => {
  const thread = side({ title: drawingTitle("a fox") });
  assert.equal(drawingPending({ ...thread, latestRunId: null }).status, "drawing");
  assert.equal(drawingPending({ ...thread, status: "running", activeRunId: "r1" }).status, "drawing");
  assert.equal(drawingPending(thread), null);
  const ready = drawingResult(thread, [reply("```json\n" + JSON.stringify(fox) + "\n```")], [{ id: "r1", ordinal: 1, status: "completed" }]);
  assert.equal(ready.status, "ready");
  assert.equal(ready.description, "a fox");
  assert.equal(drawingResult(thread, [], [{ id: "r1", ordinal: 1, status: "failed" }]).status, "failed");
  assert.equal(drawingResult(thread, [], [{ id: "r1", ordinal: 1, status: "completed" }]).error, "The Bot finished without an avatar.");
});
