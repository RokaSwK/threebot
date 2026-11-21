import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { botAvatarPng, botAvatarUrl, botBadgePng, botBadgeUrl } from "./bot-icons.mts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("a drawn Bot gets a stable PNG icon and a monochrome badge", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "threebot-icons-"));
  const bot = { slug: "alpha", workspaceRoot, shape: "sphere", color: "teal" };
  const icon = await botAvatarPng(bot);
  assert.ok(icon.subarray(0, 8).equals(PNG));
  const meta = await sharp(icon).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 192);
  assert.equal(meta.height, 192);
  assert.equal(await botAvatarPng(bot), icon, "the same look is rendered once");
  const recolored = await botAvatarPng({ ...bot, color: "pink" });
  assert.notEqual(recolored, icon, "a new look replaces the cached icon");
  assert.equal(await botAvatarPng({ ...bot, color: "pink" }), recolored);
  const badge = await botBadgePng(bot);
  const badgeMeta = await sharp(badge).metadata();
  assert.equal(badgeMeta.width, 96);
  assert.equal(badgeMeta.hasAlpha, true);
  assert.equal(botAvatarUrl(bot), "/api/bots/alpha/avatar.png");
  assert.equal(botBadgeUrl(bot), "/api/bots/alpha/badge.png");
});

test("a Bot with a picture uses it for the icon and has no monochrome badge", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "threebot-icons-"));
  const hash = "a".repeat(64);
  await mkdir(path.join(workspaceRoot, ".bot/avatar-images"), { recursive: true });
  const picture = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#2fa8a0" } }).png().toBuffer();
  await writeFile(path.join(workspaceRoot, `.bot/avatar-images/${hash}.png`), picture);
  const bot = { slug: "alpha", workspaceRoot, shape: "sphere", color: "teal", avatarImage: `/api/bots/alpha/avatar/${hash}.png` };
  const icon = await botAvatarPng(bot);
  const meta = await sharp(icon).metadata();
  assert.equal(meta.width, 192);
  assert.equal(botBadgeUrl(bot), null);
  await assert.rejects(botBadgePng(bot), (error: { status?: number }) => error.status === 404);
});
