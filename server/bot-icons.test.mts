import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { APP_BADGE_URL, appBadgePng, botAvatarPng, botAvatarUrl, botBadgePng, botBadgeUrl, botFace, botIconData, roomIdentity } from "./bot-icons.mts";
import { fitPayload } from "./push.mts";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

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
  assert.match(botAvatarUrl(bot), /^\/api\/bots\/alpha\/avatar\.png\?v=[\w-]{12}$/);
  assert.match(botBadgeUrl(bot), /^\/api\/bots\/alpha\/badge\.png\?v=[\w-]{12}$/);
  assert.notEqual(botAvatarUrl({ ...bot, color: "#39ff14" }), botAvatarUrl(bot), "a new look (custom colour too) is a new URL");
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
  assert.equal(botBadgeUrl(bot), APP_BADGE_URL, "a photo falls back to Threebot's own monochrome badge");
  const embedded = await botIconData(bot);
  assert.match(embedded.iconData, /^data:image\/webp;base64,/);
  assert.equal((await sharp(Buffer.from(embedded.badgeData.split(",")[1], "base64")).metadata()).width, 36);
  const app = await sharp(await appBadgePng()).raw().toBuffer({ resolveWithObject: true });
  assert.ok([...app.data].every((value, index) => index % 4 === 3 || value === 255), "the app badge is white");
  await assert.rejects(botBadgePng(bot), (error: { status?: number }) => error.status === 404);
});

test("a symlinked .bot folder cannot lead the icon outside the Bot's folder", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "threebot-outside-"));
  const hash = "b".repeat(64);
  await mkdir(path.join(outside, "avatar-images"), { recursive: true });
  await writeFile(path.join(outside, `avatar-images/${hash}.png`), await sharp({ create: { width: 8, height: 8, channels: 4, background: "#000" } }).png().toBuffer());
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "threebot-icons-"));
  await symlink(outside, path.join(workspaceRoot, ".bot"));
  const bot = { slug: "linked", workspaceRoot, shape: "sphere", color: "teal", avatarImage: `/api/bots/linked/avatar/${hash}.png` };
  const icon = await botAvatarPng(bot);
  const drawn = await botAvatarPng({ ...bot, slug: "drawn", avatarImage: null });
  assert.ok(icon.equals(drawn), "the outside picture is never read: the Bot's drawn face stands in");
});

test("a room push shows the Bot that spoke, with its badge and embedded copies", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "threebot-icons-"));
  const speaker = { slug: "alpha", workspaceRoot, shape: "blob", color: "#e8590c" };
  const identity = await roomIdentity(speaker);
  assert.equal(identity.icon, botAvatarUrl(speaker));
  assert.equal(identity.badge, botBadgeUrl(speaker));
  assert.match(identity.iconData ?? "", /^data:image\/webp;base64,/);
  assert.deepEqual(await roomIdentity(null), { icon: "/icon-192.png", badge: APP_BADGE_URL }, "only a room push with no speaker keeps the app's");
});

test("a noisy transparent photo still fits the push with both images, and a huge name gives way first", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "threebot-icons-"));
  const hash = "c".repeat(64);
  await mkdir(path.join(workspaceRoot, ".bot/avatar-images"), { recursive: true });
  const noise = await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
  await writeFile(path.join(workspaceRoot, `.bot/avatar-images/${hash}.png`), noise);
  const bot = { slug: "noisy", workspaceRoot, shape: "sphere", color: "teal", avatarImage: `/api/bots/noisy/avatar/${hash}.png` };
  const identity = await roomIdentity(bot);
  const payload = { title: "😀".repeat(1024), body: "😀".repeat(140), tag: "waiting:noisy:t", url: "/?bot=noisy&thread=t", bot: "noisy", ...identity };
  const fitted = fitPayload(payload);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 3_500);
  assert.ok(fitted.iconData && fitted.badgeData, "the Bot's face stays in the push");
});

test("a picture that can't be read shows the drawn face for now, and the picture again once it is back", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "threebot-icons-"));
  const hash = "d".repeat(64);
  const file = path.join(workspaceRoot, `.bot/avatar-images/${hash}.png`);
  const bot = { slug: "restored", workspaceRoot, shape: "sphere", color: "teal", avatarImage: `/api/bots/restored/avatar/${hash}.png` };
  const missing = await botFace(bot);
  assert.equal(missing.fallback, true);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ff0000" } }).png().toBuffer());
  const back = await botFace(bot);
  assert.equal(back.fallback, false);
  assert.notEqual(back.version, missing.version, "the drawn stand-in had its own version");
  assert.ok(!back.png.equals(missing.png));
  await rm(workspaceRoot, { recursive: true, force: true });
});
