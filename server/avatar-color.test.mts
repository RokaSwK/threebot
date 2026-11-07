import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import config from "./avatar-config.json" with { type: "json" };
import { avatarColorPatch, avatarInk, colorHex, contrast, eyeInk, hexToHsv, hsvToHex, isAvatarColor, isCustomColor, NAMED_COLORS, normalizeHex, READABLE, SURFACES, textInk } from "./avatar-color.mts";
import { renderBotAvatar } from "./bot-avatar.mts";
import { renderAgentsMd } from "./bot-template.mts";
import { objectEyeColor } from "./object-avatars.mts";

// Every 24th step of each channel: 1,331 colours from black to white, including the saturated corners.
const GRID = Array.from({ length: 11 ** 3 }, (_, i) => `#${[i % 11, Math.floor(i / 11) % 11, Math.floor(i / 121)].map(n => Math.min(255, n * 25.5).toString(16).split(".")[0].padStart(2, "0")).join("")}`);
const EDGES = ["#000000", "#15131c", "#ffffff", "#fbf9f2", "#39ff14", "#1a00ff", "#ff0000", "#ffff00", "#00ffff", "#ff00ff"];

test("bot.json colours are palette names or #rrggbb, and requests are normalised or refused", () => {
  for (const name of Object.keys(NAMED_COLORS)) assert.equal(avatarColorPatch(name), name);
  assert.equal(avatarColorPatch("#3FA7D6"), "#3fa7d6");
  assert.equal(avatarColorPatch(" #3fa "), "#33ffaa");
  for (const bad of ["3fa7d6", "#3fa7d", "#3fa7d6ff", "rgb(1,2,3)", "url(#x)", "#ggg", "__proto__", "toString", "", null, undefined, 12, {}]) {
    assert.throws(() => avatarColorPatch(bad), (error: { status?: number; message: string }) => error.status === 400 && /Invalid colour/.test(error.message), String(bad));
  }
  assert.ok(isAvatarColor("#3fa7d6") && isAvatarColor("teal") && !isAvatarColor("#3fa") && !isAvatarColor("toString"));
  assert.ok(isCustomColor("#3fa7d6") && !isCustomColor("teal") && !isCustomColor("3fa7d6"));
  assert.equal(normalizeHex("ABC"), "#aabbcc");
});

test("unknown colours fall back to teal, as older versions do for a hex", () => {
  assert.equal(colorHex("#3FA7D6"), "#3fa7d6");
  assert.equal(colorHex("violet"), NAMED_COLORS.violet);
  for (const bad of [undefined, null, "", "unknown", "__proto__", "toString", "3fa7d6", "#zzzzzz"]) assert.equal(colorHex(bad), NAMED_COLORS.teal);
});

test("the picker's HSV round-trips every hex", () => {
  for (const hex of [...GRID, ...EDGES]) assert.equal(hsvToHex(hexToHsv(hex)), hex);
  assert.deepEqual(hexToHsv("#ff0000"), { h: 0, s: 1, v: 1 });
});

test("on any fill, the face stays readable on both themes", () => {
  for (const fill of [...GRID, ...EDGES]) {
    const ink = avatarInk(fill);
    for (const theme of ["light", "dark"] as const) {
      const { edge, eye, ink: overlay } = ink[theme];
      // The silhouette: the fill itself, or its outline, stands off the page.
      assert.ok(Math.max(contrast(fill, SURFACES[theme]), edge ? contrast(edge, SURFACES[theme]) : 0) >= READABLE, `${fill} ${theme}: body vanishes`);
      // The eyes: cut out (showing the page) or painted, they contrast with the body.
      assert.ok(contrast(eye ?? SURFACES[theme], fill) >= (eye ? 3 : READABLE), `${fill} ${theme}: eyes vanish`);
      // Thinking dots, rings and names around the body.
      assert.ok(contrast(overlay, SURFACES[theme]) >= READABLE, `${fill} ${theme}: overlay vanishes`);
      assert.ok(contrast(textInk(fill, theme), SURFACES[theme]) >= READABLE, `${fill} ${theme}: name vanishes`);
    }
    assert.ok(contrast(eyeInk(fill), fill) >= 3, `${fill}: painted eyes`);
    assert.ok(contrast(objectEyeColor(fill), fill) >= 4, `${fill}: object eyes`);
  }
});

test("palette colours other than white keep their look: no outline, cut-out eyes, their own ink", () => {
  for (const [name, fill] of Object.entries(NAMED_COLORS)) {
    if (name === "white" || name === "black") continue;
    assert.deepEqual(avatarInk(fill), { light: { edge: null, eye: null, ink: normalizeHex(fill) }, dark: { edge: null, eye: null, ink: normalizeHex(fill) } }, name);
  }
});

test("the favicon renderer draws a hex fill, with an outline and painted eyes where it would vanish", () => {
  const parse = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml");
  for (const shape of config.shapes) {
    const document = parse(renderBotAvatar({ shape, color: "#3FA7D6" }));
    assert.equal(document.querySelector("path[mask]").getAttribute("fill"), "#3fa7d6", shape);
    assert.equal(document.querySelectorAll("mask path[fill=black]").length, 2, `${shape}: cut-out eyes`);
  }
  for (const color of ["#15131c", "#fbf9f2", "white", "black"]) {
    const document = parse(renderBotAvatar({ shape: "ball", color }));
    const body = document.querySelector("svg > g[data-figure] > path");
    const eyes = [...document.querySelectorAll("svg > g[data-figure] g > path")];
    assert.equal(document.querySelectorAll("mask").length, 0, `${color}: eyes are painted, not cut out`);
    assert.equal(eyes.length, 2);
    for (const eye of eyes) assert.ok(contrast(eye.getAttribute("fill"), colorHex(color)) >= 3, `${color}: eyes contrast`);
    assert.ok(body.getAttribute("stroke"), `${color}: outlined`);
  }
  // Object icons draw no outline of their own: one that would vanish into a page gets a grown edge.
  for (const color of ["#f9f8fd", "#16141f", "white"]) assert.match(renderBotAvatar({ shape: "object:ghost", color }), /<g filter="url\(#threebot-edge\)">/, color);
  assert.doesNotMatch(renderBotAvatar({ shape: "object:ghost", color: "#3fa7d6" }), /threebot-edge/);
  // A hex fill reaches object avatars too.
  assert.match(renderBotAvatar({ shape: "object:ghost", color: "#5b2a86" }), /#5b2a86/i);
  assert.notEqual(renderBotAvatar({ shape: "ball", color: "#3fa7d6" }), renderBotAvatar({ shape: "ball", color: "teal" }));
});

test("Bots are told they can set a hex colour", () => {
  const text = renderAgentsMd({ bot: { name: "Roka", slug: "roka", projectId: "p", mainThreadId: "t" }, settings: {}, botsRoot: "/bots" });
  assert.match(text, /`color` is one of black, white, brown/);
  assert.match(text, /"#rrggbb"/);
  assert.match(text, /"color": "<a colour name, or #rrggbb>"/);
});
