import sharp, { type SharpOptions } from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const MAX_AVATAR_BYTES = 25 * 1024 * 1024;
export const AVATAR_BODY_LIMIT = Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 65536;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const imagePath = /^\/api\/bots\/[a-z0-9][a-z0-9-]{0,62}\/avatar\/([a-f0-9]{64})\.png$/;
export function avatarImageFile(image: unknown) {
  const match = typeof image === 'string' && imagePath.exec(image);
  return match ? `.bot/avatar-images/${match[1]}.png` : null;
}

/** Decode the bytes, constrain decoded pixels, and re-encode a static PNG.
 * No user metadata, SVG, animation, filename, or executable payload is served. */
export async function decodeAvatarImage(value: unknown) {
  if (typeof value !== 'string') throw fail('That image could not be loaded');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw fail('That image could not be loaded');
  if (match[2].length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) throw fail('Choose an image smaller than 25 MB', 413);
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_AVATAR_BYTES) throw fail('Choose an image smaller than 25 MB', 413);
  if (!bytes.length || bytes.toString('base64') !== match[2]) throw fail('That image could not be loaded');
  const signature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : match[1] === 'webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (!signature) throw fail('That image could not be loaded');
  try {
    const options: SharpOptions = { limitInputPixels: 40_000_000, failOn: 'warning', animated: false };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== match[1] || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw Error('format');
    return await sharp(bytes, options).rotate().resize(1024, 1024, { fit: 'cover', withoutEnlargement: true }).png().toBuffer();
  } catch { throw fail('That image could not be loaded'); }
}
export async function storeAvatarImage({ workspaceRoot, slug }: { workspaceRoot: string; slug: string }, bytes: Buffer) {
  const revision = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(workspaceRoot, '.bot/avatar-images', revision + '.png');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return `/api/bots/${slug}/avatar/${revision}.png`;
}
export async function readAvatarImage(bot: { workspaceRoot: string }, image: unknown) {
  const relative = avatarImageFile(image);
  if (!relative) throw fail('not found', 404);
  const handle = await open(path.join(bot.workspaceRoot, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

/** Only the gateway may mint image references. Existing URLs can be retained,
 * but a client cannot point a Bot at an arbitrary file or another Bot's image. */
export async function avatarImagePatch<T extends { avatarImage?: unknown; [key: string]: unknown }>(bot: { workspaceRoot: string; slug: string; avatarImage?: unknown }, patch: T): Promise<T> {
  if (!Object.hasOwn(patch, 'avatarImage') || patch.avatarImage === bot.avatarImage) return patch;
  return { ...patch, avatarImage: patch.avatarImage === null ? null : await storeAvatarImage(bot, await decodeAvatarImage(patch.avatarImage)) };
}
