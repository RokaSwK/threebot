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
    load: (id) => id === "\0object-avatars-test" ? `export * from ${JSON.stringify(`${src}lib/objectAvatars.ts`)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:object-avatars-test", write: false },
});
const entry = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
assert.ok(entry, "test bundle has an entry point");
const { importDefinition, isObjectShape, OBJECT_AVATARS, objectDefinition, objectMood, objectShape, safeDefinition } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);

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
