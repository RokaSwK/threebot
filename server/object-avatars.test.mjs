import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBotAvatar } from "./bot-avatar.mjs";
import { renderAgentsMd } from "./bot-template.mjs";
import { OBJECT_AVATAR_IDS, objectAvatarPatch, objectDefinition, objectEyeColor } from "./object-avatars.mjs";

const fox = { version: 1, id: "fox", name: "Fox", body: { path: "M20 20 H80 V80 H20 Z" }, eyes: { x: 50, y: 46, spacing: 15, scale: 1 } };

test("every gallery object resolves and renders a self-contained icon", () => {
  assert.equal(OBJECT_AVATAR_IDS.length, 22);
  for (const id of OBJECT_AVATAR_IDS) {
    const svg = renderBotAvatar({ shape: `object:${id}`, color: "teal" });
    assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, id);
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|href="(?!#)/, id);
  }
});

test("icons are stable and follow color and geometry", () => {
  const a = renderBotAvatar({ shape: "object:ghost", color: "teal" });
  assert.equal(renderBotAvatar({ shape: "object:ghost", color: "teal" }), a);
  assert.notEqual(renderBotAvatar({ shape: "object:ghost", color: "red" }), a);
  assert.notEqual(renderBotAvatar({ shape: "object:cat", color: "teal" }), a);
});

test("a Bot's own definition works, and a bad one falls back to the engine", () => {
  assert.equal(objectDefinition({ shape: "object:fox", avatarDefinition: fox }).id, "fox");
  assert.equal(objectDefinition({ shape: "object:fox", avatarDefinition: { ...fox, body: { path: "not a path" } } }), null);
  assert.equal(objectDefinition({ shape: "object:other", avatarDefinition: fox }), null);
  assert.equal(objectDefinition({ shape: "ball" }), null);
  assert.match(renderBotAvatar({ shape: "object:missing", color: "teal" }), /<svg/);
});

test("a gallery id can't be redefined by a Bot's file", () => {
  const ghost = objectDefinition({ shape: "object:ghost", avatarDefinition: { ...fox, id: "ghost" } });
  assert.notEqual(ghost.body.path, fox.body.path);
});

test("saving validates, rewrites and clears definitions", () => {
  const saved = objectAvatarPatch({ avatarDefinition: fox });
  assert.equal(saved.shape, "object:fox");
  assert.match(saved.avatarDefinition.body.path, /^M/);
  assert.throws(() => objectAvatarPatch({ avatarDefinition: { ...fox, extra: 1 } }), (error) => error.status === 400);
  assert.throws(() => objectAvatarPatch({ avatarDefinition: { ...fox, id: "ghost" } }), (error) => error.status === 400);
  assert.throws(() => objectAvatarPatch({ avatarDefinition: { ...fox, body: { path: "" } } }), (error) => error.status === 400 && /path is empty/.test(error.message));
  assert.equal(objectAvatarPatch({ shape: "ball" }).avatarDefinition, null);
  assert.equal(objectAvatarPatch({ shape: "object:ghost", avatarDefinition: null }).avatarDefinition, null);
  assert.deepEqual(objectAvatarPatch({ color: "red" }), { color: "red" });
});

test("markup can't travel through a definition", () => {
  const attack = '"/><img src=x onerror=alert(1)>';
  assert.throws(() => objectAvatarPatch({ avatarDefinition: { ...fox, body: { path: `M20 20 H80 V80 H20 Z${attack}` } } }));
  assert.throws(() => objectAvatarPatch({ avatarDefinition: { ...fox, name: `<img src=x>` } }));
  assert.throws(() => objectAvatarPatch({ avatarDefinition: { ...fox, id: attack } }));
});

test("eyes stay readable on dark bodies", () => {
  assert.equal(objectEyeColor("#000000"), "#ffffff");
  assert.equal(objectEyeColor("#ffffff"), "#151515");
});

test("Bots know how to change their look and draw themselves", () => {
  const text = renderAgentsMd({ bot: { name: "Roka", slug: "roka", projectId: "p", mainThreadId: "t" }, settings: {}, botsRoot: "/bots" });
  assert.match(text, /object:<id>/);
  assert.match(text, /witch-hat/);
  assert.match(text, /"avatarDefinition"/);
});
