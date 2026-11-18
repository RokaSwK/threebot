import sharp from "sharp";
import { renderBotAvatar, type AvatarBot } from "./bot-avatar.mts";
import { avatarImageFile, readAvatarImage } from "./avatar-images.mts";

// Notification icons are fetched as bitmaps: Chrome does not display SVG here, and Android wants a
// real PNG. The Bot's drawn avatar is rasterized once per look, with the same engine the app uses,
// so a notification and the sidebar show the same character.
const ICON_SIZE = 192;
const BADGE_SIZE = 96;
const icons = new Map<string, Buffer>();
const badges = new Map<string, Buffer>();

export type IconBot = AvatarBot & { slug: string; workspaceRoot: string; avatarImage?: unknown };

/** Always this route: it serves the uploaded picture or the drawn avatar, whichever the Bot has. */
export function botAvatarUrl(bot: { slug: string }): string {
  return `/api/bots/${encodeURIComponent(bot.slug)}/avatar.png`;
}

/** Android's status bar icon: a monochrome silhouette of the drawn avatar; a photo has none. */
export function botBadgeUrl(bot: IconBot): string | null {
  return avatarImageFile(bot.avatarImage) ? null : `/api/bots/${encodeURIComponent(bot.slug)}/badge.png`;
}

/** Changes exactly when the drawn look changes, so the cache follows shape, color and object look. */
function look(bot: IconBot): string {
  return JSON.stringify({ shape: bot.shape, color: bot.color, definition: bot.avatarDefinition ?? null });
}

export async function botAvatarPng(bot: IconBot): Promise<Buffer> {
  const picture = avatarImageFile(bot.avatarImage);
  const key = `avatar:${bot.slug}:${picture ?? look(bot)}`;
  const hit = icons.get(key);
  if (hit) return hit;
  const png = picture
    ? await sharp(await readAvatarImage(bot, bot.avatarImage)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer()
    : await sharp(Buffer.from(renderBotAvatar(bot))).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();
  icons.set(key, png);
  return png;
}

export async function botBadgePng(bot: IconBot): Promise<Buffer> {
  if (avatarImageFile(bot.avatarImage)) throw Object.assign(new Error("not found"), { status: 404 });
  const key = `badge:${look(bot)}`;
  const hit = badges.get(key);
  if (hit) return hit;
  // Android draws the badge through the alpha channel: keep the silhouette, paint it white.
  const { data, info } = await sharp(Buffer.from(renderBotAvatar(bot)))
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
  const png = await sharp(white, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  badges.set(key, png);
  return png;
}
