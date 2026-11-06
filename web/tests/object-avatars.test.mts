import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
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
const entry = entryChunk(bundle);
assert.ok(entry, "test bundle has an entry point");
const { DRAWING_RULES, drawingDescription, drawingModel, drawingOf, drawingsOf, drawingPending, drawingPrompt, drawingResult, drawingTitle, fastDrawingModel, fixPrompt, importDefinition, isAvatarDrawing, isObjectShape, OBJECT_AVATARS, objectDefinition, objectMood, objectShape, parseDrawing, safeDefinition, sideChatsOf } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

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

test("a drawing is the newest set of hidden side chats in the Bot's project, which side chat lists leave out", () => {
  const bot = { mainThreadId: "main", projectId: "p" };
  const option = (id, patch = {}) => side({ id, projectId: "p", title: drawingTitle("a fox with a scarf"), createdAt: `2026-11-06T10:00:0${id.at(-1)}Z`, lineage: { parentThreadId: "job", relationshipToParent: "fork", rootThreadId: "job", sideChat: true }, ...patch });
  const threads = { o2: option("o2"), o1: option("o1"), o3: option("o3"), s: side({ projectId: "p" }),
    older: side({ id: "older", projectId: "p", title: drawingTitle("an owl"), createdAt: "2026-11-05T00:00:00Z", lineage: { parentThreadId: "old-job", relationshipToParent: "fork", rootThreadId: "old-job", sideChat: true } }),
    elsewhere: side({ id: "elsewhere", projectId: "q", title: drawingTitle("a cat"), createdAt: "2026-11-07T00:00:00Z", lineage: { parentThreadId: "other-job", relationshipToParent: "fork", rootThreadId: "other-job", sideChat: true } }) };
  assert.equal(isAvatarDrawing(threads.o1), true);
  assert.equal(isAvatarDrawing(side()), false);
  assert.deepEqual(sideChatsOf(threads, "main").map((t) => t.id), ["s"]);
  assert.deepEqual(drawingOf(threads, bot).map((t) => t.id), ["o1", "o2", "o3"], "options in order, the older drawing and other Bots' left out");
  assert.deepEqual(drawingsOf(threads, bot).map((t) => t.id).sort(), ["o1", "o2", "o3", "older"], "discarding clears the older drawing too");
  assert.deepEqual(drawingOf(threads, { mainThreadId: "other", projectId: "r" }), []);
  // A drawing started before this change is a side chat of the main thread, and still counts.
  assert.deepEqual(drawingOf({ legacy: side({ id: "legacy", title: drawingTitle("an owl") }) }, { mainThreadId: "main", projectId: null }).map((t) => t.id), ["legacy"]);
  const long = `a fox with ${"a very long striped scarf, ".repeat(6)}and boots`;
  assert.equal(drawingDescription(side({ title: drawingTitle(` ${long}\n`) })), long, "Try again asks for the whole description");
});

test("the drawing prompt is only the avatar rules and the description, the same rules as AGENTS.md", async () => {
  const prompt = drawingPrompt("  a fox with a scarf ", 2, 3);
  assert.match(prompt, /^Draw one object avatar: a fox with a scarf\./);
  assert.match(prompt, /```json/);
  assert.match(prompt, /option 2 of 3/);
  assert.doesNotMatch(drawingPrompt("a fox"), /option/);
  assert.doesNotMatch(prompt, /bot\.json|yourself|your instructions/, "nothing about the Bot");
  const { readFile } = await import("node:fs/promises");
  const agents = await readFile(new URL("../../server/bot-template.mts", import.meta.url), "utf8");
  for (const rule of ["0 0 100 100", "within 8..92", "wound clockwise", "M L H V C S Q T A Z", "under 1500 characters", "Put the eyes on the biggest part, with about 36 by 25 units of solid fill around them"]) {
    assert.ok(DRAWING_RULES.includes(rule), `prompt has: ${rule}`);
    assert.ok(agents.includes(rule), `AGENTS.md has: ${rule}`);
  }
  assert.match(fixPrompt("The drawing didn't validate: body.path: path is empty"), /^That avatar didn't validate: body\.path: path is empty/);
});

const descriptor = (id, options) => ({ id, label: id, type: "select", options: options.map(([id, label]) => ({ id, label })) });
const codex = { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, status: "ready", models: [
  { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { slug: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
  { slug: "gpt-6-luna", name: "GPT-6-Luna", capabilities: { optionDescriptors: [descriptor("reasoningEffort", [["low", "Low"], ["medium", "Medium"]]), descriptor("serviceTier", [["default", "Standard"], ["priority", "Fast"]])] } }] };
const claude = { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, status: "ready", models: [
  { slug: "claude-opus-5-5", name: "Opus 5.5" }, { slug: "claude-haiku-4-5", name: "Haiku 4.5" },
  { slug: "claude-haiku-5-5", name: "Haiku 5.5", capabilities: { optionDescriptors: [descriptor("effort", [["low", "Low"], ["high", "High"]])] } }] };

test("drawing picks GPT-6 Luna on the fast tier, then Claude Haiku, then the Bot's own model", () => {
  assert.deepEqual(fastDrawingModel([claude, codex]), { instanceId: "codex", model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }, { id: "serviceTier", value: "priority" }] });
  assert.deepEqual(fastDrawingModel([claude]), { instanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] });
  assert.equal(fastDrawingModel([{ ...codex, status: "disabled" }]), null, "a provider that isn't ready is skipped");
  const own = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  assert.equal(drawingModel([], null, own), own);
  const setting = { instanceId: "claudeAgent", model: "claude-haiku-4-5" };
  assert.equal(drawingModel([codex, claude], setting, own), setting, "the setting wins while it's offered");
  assert.equal(drawingModel([codex], setting, own).model, "gpt-6-luna", "and falls back when it isn't");
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

test("an option is pending until its run finishes; a reply that doesn't validate gets one fix", () => {
  const thread = side({ title: drawingTitle("a fox") });
  assert.equal(drawingPending({ ...thread, latestRunId: null }).status, "drawing");
  assert.equal(drawingPending({ ...thread, status: "running", activeRunId: "r1" }).status, "drawing");
  assert.equal(drawingPending(thread), null);
  const one = [{ id: "r1", ordinal: 1, status: "completed" }], two = [...one, { id: "r2", ordinal: 2, status: "completed" }];
  assert.equal(drawingResult(thread, [reply("```json\n" + JSON.stringify(fox) + "\n```")], one).status, "ready");
  assert.equal(drawingResult(thread, [], [{ id: "r1", ordinal: 1, status: "failed" }]).status, "failed");
  const broken = reply("```json\n" + JSON.stringify({ ...fox, body: { path: "" } }) + "\n```");
  const fixing = drawingResult(thread, [broken], one);
  assert.equal(fixing.status, "fixing");
  assert.match(fixing.retry, /path is empty/);
  const failed = drawingResult(thread, [broken, broken], two);
  assert.equal(failed.status, "failed", "only one fix");
  assert.equal(failed.retry, undefined);
  assert.equal(drawingResult(thread, [], one).retry, "The model finished without an avatar.");
});
