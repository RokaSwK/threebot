import { createHash } from "node:crypto";
import sharp from "sharp";
import { renderBotAvatar, type AvatarBot } from "./bot-avatar.mts";
import { avatarImageFile, readAvatarImage } from "./avatar-images.mts";

// Notification icons are fetched as bitmaps: Chrome does not display SVG here, and Android wants a
// real PNG. The Bot's drawn avatar is rasterized once per look, with the same engine the app uses,
// so a notification and the sidebar show the same character.
const ICON_SIZE = 192;
const BADGE_SIZE = 96;
// One entry per Bot and image: a new look replaces the old one, so the cache never outgrows the Bots.
// A render in flight is shared, and a failed one is dropped so the next request tries again.
const cache = new Map<string, { look: string; png: Promise<Buffer> }>();

function cached(slot: string, key: string, render: () => Promise<Buffer>): Promise<Buffer> {
  const hit = cache.get(slot);
  if (hit?.look === key) return hit.png;
  const png = render();
  const entry = { look: key, png };
  cache.set(slot, entry);
  png.catch(() => { if (cache.get(slot) === entry) cache.delete(slot); });
  return png;
}

export type IconBot = AvatarBot & { slug: string; workspaceRoot: string; avatarImage?: unknown };

/** Threebot's own monochrome badge, for a Bot with a photo (a photo has no silhouette worth drawing). */
export const APP_BADGE_URL = "/api/push/badge.png";
// The app icon's character: a round body with two eyes, cut out (a mid-tone fill keeps the eyes cut).
const APP_LOOK: AvatarBot = { shape: "ball", color: "purple" };
// The copies a push carries inside itself are small, so the whole message stays under the push
// services' 4 KB limit.
const EMBED_ICON = 64;
const EMBED_ICON_BYTES = 1_400;

/** The largest small icon that fits its share of a push: a noisy photo steps down in size and quality. */
async function smallIcon(png: Buffer): Promise<Buffer> {
  let out = Buffer.alloc(0);
  for (const [size, quality] of [[EMBED_ICON, 50], [56, 40], [48, 35], [40, 30], [32, 25], [24, 20]]) {
    out = await sharp(png).resize(size, size).webp({ quality, alphaQuality: quality }).toBuffer();
    if (out.length <= EMBED_ICON_BYTES) break;
  }
  return out;
}
const EMBED_BADGE = 36;

/** Changes exactly when the drawn look changes, so the cache follows shape, color and object look. */
function look(bot: AvatarBot): string {
  return JSON.stringify({ shape: bot.shape, color: bot.color, definition: bot.avatarDefinition ?? null });
}

/** What the Bot looks like now: its picture's content hash, or a hash of the drawn look. */
export function iconVersion(bot: IconBot): string {
  return createHash("sha256").update(avatarImageFile(bot.avatarImage) ?? look(bot)).digest("base64url").slice(0, 12);
}

/** The uploaded picture or the drawn avatar, whichever the Bot has. A new look is a new URL, so no cache shows an old one. */
export function botAvatarUrl(bot: IconBot): string {
  return `/api/bots/${encodeURIComponent(bot.slug)}/avatar.png?v=${iconVersion(bot)}`;
}

/** Android's status bar icon: the drawn avatar's white silhouette, or Threebot's own for a photo. */
export function botBadgeUrl(bot: IconBot): string {
  return avatarImageFile(bot.avatarImage) ? APP_BADGE_URL : `/api/bots/${encodeURIComponent(bot.slug)}/badge.png?v=${iconVersion(bot)}`;
}

/**
 * The Bot's face as it can be shown now: its picture, or its drawn avatar when the picture can't be
 * read here (gone, or on another machine), never a letter. `version` names what was drawn, and a
 * failed read is not cached, so a restored picture shows again.
 */
export async function botFace(bot: IconBot): Promise<{ png: Buffer; version: string; fallback: boolean }> {
  const picture = avatarImageFile(bot.avatarImage);
  if (picture) {
    try {
      const png = await cached(`avatar:${bot.slug}`, picture, async () => sharp(await readAvatarImage(bot, bot.avatarImage)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer());
      return { png, version: iconVersion(bot), fallback: false };
    } catch { /* the drawn face below */ }
  }
  const drawn = await cached(`avatar-drawn:${bot.slug}`, look(bot), async () => sharp(Buffer.from(renderBotAvatar(bot))).resize(ICON_SIZE, ICON_SIZE).png().toBuffer());
  return { png: drawn, version: iconVersion({ ...bot, avatarImage: null }), fallback: Boolean(picture) };
}

export async function botAvatarPng(bot: IconBot): Promise<Buffer> {
  return (await botFace(bot)).png;
}

/** Android draws a badge through its alpha channel: keep the silhouette, paint it white. */
async function silhouette(look: AvatarBot): Promise<Buffer> {
  const { data, info } = await sharp(Buffer.from(renderBotAvatar(look)))
    .resize(BADGE_SIZE, BADGE_SIZE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const white = Buffer.from(data);
  for (let index = 0; index < white.length; index += 4) {
    white[index] = 255;
    white[index + 1] = 255;
    white[index + 2] = 255;
  }
  return sharp(white, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

export async function botBadgePng(bot: IconBot): Promise<Buffer> {
  if (avatarImageFile(bot.avatarImage)) throw Object.assign(new Error("not found"), { status: 404 });
  return cached(`badge:${bot.slug}`, look(bot), () => silhouette(bot));
}

export function appBadgePng(): Promise<Buffer> {
  return cached("app-badge", look(APP_LOOK), () => silhouette(APP_LOOK));
}

/**
 * Small copies of the icon and badge for the push itself: a device that cannot fetch at display
 * time (offline, or a signed-out Access session) still shows the Bot, not a letter.
 */
export async function botIconData(bot: IconBot): Promise<{ iconData: string; badgeData: string }> {
  const face = await botFace(bot);
  const photo = Boolean(avatarImageFile(bot.avatarImage));
  const [icon, badge] = await Promise.all([
    cached(`embed-icon:${bot.slug}`, face.version, () => smallIcon(face.png)),
    cached(`embed-badge:${bot.slug}`, iconVersion(bot), async () => sharp(await (photo ? appBadgePng() : botBadgePng(bot))).resize(EMBED_BADGE, EMBED_BADGE).png({ palette: true, colours: 4, compressionLevel: 9 }).toBuffer()),
  ]);
  return { iconData: `data:image/webp;base64,${icon.toString("base64")}`, badgeData: `data:image/png;base64,${badge.toString("base64")}` };
}

/** Everything a push needs to show this Bot: full-size URLs, and the small copies for when they can't load. */
export async function botIdentity(bot: IconBot): Promise<{ icon: string; badge: string; iconData?: string; badgeData?: string }> {
  const urls = { icon: botAvatarUrl(bot), badge: botBadgeUrl(bot) };
  return { ...urls, ...await botIconData(bot).catch(() => ({})) };
}

/** A room push: a room has no avatar of its own, so it shows the Bot that is waiting or spoke last. */
export async function roomIdentity(speaker: IconBot | null | undefined): Promise<{ icon: string; badge: string; iconData?: string; badgeData?: string }> {
  return speaker ? botIdentity(speaker) : { icon: "/icon-192.png", badge: APP_BADGE_URL };
}
