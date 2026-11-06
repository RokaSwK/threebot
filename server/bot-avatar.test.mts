import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DOMParser } from "linkedom";
import config from "./avatar-config.json" with { type: "json" };
import { ensureBotFavicon, renderBotAvatar, syncBotProject } from "./bot-avatar.mts";

test("the blob fills its icon instead of keeping the study playground's margins", () => {
  const document = new DOMParser().parseFromString(renderBotAvatar({ shape: "blob", color: "teal" }), "image/svg+xml");
  const [, , width, height] = document.documentElement.getAttribute("viewBox").split(/\s+/).map(Number);
  // The reference blob is 228.541 units across before its login pose scale.
  assert.ok(228.541 / width >= 0.9, "The character should fill at least 90% of its icon width");
  assert.equal(height, width);
});

test("every reference shape and color renders a standalone SVG with transparent eyes", () => {
  const silhouettes = new Set();
  for (const shape of config.shapes) {
    for (const [color, fill] of Object.entries(config.colors)) {
      const svg = renderBotAvatar({ shape, color });
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");
      const body = document.querySelector("path[mask]");
      assert.ok(body?.getAttribute("d")?.length > 100, `${shape}/${color}: missing body`);
      assert.equal(body.getAttribute("fill"), fill);
      assert.equal(document.querySelectorAll("mask path[fill=black]").length, 2);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
      silhouettes.add(body.getAttribute("d"));
    }
  }
  assert.equal(silhouettes.size, config.shapes.length);
});

test("existing bot shape names keep working and invalid metadata falls back", () => {
  for (const [alias, shape] of Object.entries(config.shapeAliases)) {
    assert.equal(renderBotAvatar({ shape: alias, color: "blue" }), renderBotAvatar({ shape, color: "blue" }));
  }
  // Deliberately not strings: bot.json can hold anything.
  for (const invalid of [undefined, null, "unknown", "__proto__", "toString"] as string[]) {
    assert.equal(renderBotAvatar({ shape: invalid, color: invalid }), renderBotAvatar({ shape: "blob", color: "teal" }));
  }
});

test("T3 exports its fixed illustrated palette and white eyes as a self-contained favicon", () => {
  const svg = renderBotAvatar({ shape: "t3", color: "purple" });
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const scene = document.querySelector('[data-avatar-skin="t3"]');
  assert.ok(scene);
  assert.equal(document.querySelectorAll("mask").length, 0, "white eyes must not punch holes in the sky");
  assert.equal(scene.nextSibling.querySelectorAll('path[fill="#ffffff"]').length, 2);
  assert.ok(scene.querySelector('[data-layer="sky-glow"]'));
  assert.ok(scene.querySelector('[data-layer="horizon-glow"]'));
  for (const depth of ["far", "middle", "near"]) assert.ok(scene.querySelector(`[data-layer="clouds-${depth}"] path`));
  assert.ok(scene.querySelectorAll("[data-star]").length > 0);
  for (const meteor of scene.querySelectorAll("[data-meteor]")) assert.equal(meteor.getAttribute("opacity"), "0", "still icons contain no mid-flight meteor");
  assert.doesNotMatch(svg, /NaN|Infinity|undefined|<image|<animate/);
  for (const element of document.querySelectorAll("[fill], [clip-path]")) {
    for (const attribute of ["fill", "clip-path"]) {
      const id = element.getAttribute(attribute)?.match(/^url\(#(.+)\)$/)?.[1];
      if (id) assert.ok(document.getElementById(id), `missing SVG definition ${id}`);
    }
  }
  for (const color of Object.keys(config.colors)) assert.equal(renderBotAvatar({ shape: "t3", color }), svg);
  assert.notEqual(renderBotAvatar({ shape: "blob", color: "purple" }), svg);
});

test("project favicon follows edits, is readable from disk, and converges without repeat writes", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bot-favicon-"));
  try {
    const bot = { workspaceRoot, shape: "cloud", color: "blue", name: "Cloud Bot" };
    const project: { id: string; title: string; faviconPath: string | null; projectIcon: unknown } = { id: "project-test", title: "Old name", faviconPath: null, projectIcon: { kind: "emoji", emoji: "🤖" } };
    const mutations: Record<string, unknown>[] = [];
    const client = { async call(method: string, input: Record<string, unknown>) {
      assert.equal(method, "projects.mutate");
      mutations.push(input);
      Object.assign(project, input);
    } };
    await syncBotProject(client, bot, project);
    assert.equal(mutations.length, 1);
    assert.equal(project.title, bot.name);
    assert.equal(project.projectIcon, null);
    assert.match(project.faviconPath!, /^\.bot\/avatar-[a-f0-9]{12}\.svg$/);
    const firstFile = path.join(workspaceRoot, project.faviconPath!);
    assert.equal(await readFile(firstFile, "utf8"), renderBotAvatar(bot));
    const firstMtime = (await stat(firstFile)).mtimeMs;
    await syncBotProject(client, bot, project);
    assert.equal(mutations.length, 1);
    assert.equal((await stat(firstFile)).mtimeMs, firstMtime);
    for (const patch of [{ shape: "leaf" }, { color: "red" }, { shape: "t3" }, { shape: "blob" }]) {
      const previousPath = project.faviconPath;
      Object.assign(bot, patch);
      await syncBotProject(client, bot, project);
      assert.notEqual(project.faviconPath, previousPath);
      assert.equal(await readFile(path.join(workspaceRoot, project.faviconPath!), "utf8"), renderBotAvatar(bot));
    }
    // Recreate a missing icon after a restore without changing its revision.
    await rm(path.join(workspaceRoot, project.faviconPath!));
    assert.equal(await ensureBotFavicon(bot), project.faviconPath);
    assert.equal(await readFile(path.join(workspaceRoot, project.faviconPath!), "utf8"), renderBotAvatar(bot));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('picker silhouettes and colors render', () => {
  assert.equal(config.shapes.length, 17);
  assert.equal(Object.keys(config.colors).length, 12);
  assert.equal(config.pickerShapes.length, 14);
  assert.equal(config.pickerShapes.at(-1), 't3');
  assert.equal(config.pickerColors.length, 11);
  const paths = new Set();
  for (const shape of config.pickerShapes.filter(shape => shape !== 't3')) {
    const svg = renderBotAvatar({ shape, color: 'blue' });
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const body = doc.querySelector('path[mask]');
    assert.equal(body.getAttribute('fill'), '#1084FE');
    paths.add(body.getAttribute('d'));
  }
  assert.equal(paths.size, 13);
});

test("every Bot icon is a standalone SVG a browser can draw as an image", () => {
  for (const bot of [{ shape: "t3", color: "violet" }, { shape: "ball", color: "teal" }, { shape: "star", color: "white" }]) {
    assert.match(renderBotAvatar(bot), /^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  }
});
