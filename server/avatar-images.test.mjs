import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { decodeAvatarImage, storeAvatarImage, avatarImagePatch, avatarImageFile, readAvatarImage, MAX_AVATAR_BYTES } from './avatar-images.mjs';
import { ensureBotFavicon } from './bot-avatar.mjs';

const dataUrl = (bytes, type = 'png') => `data:image/${type};base64,${bytes.toString('base64')}`;
const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#ff1234' } }).png().toBuffer();

test('avatar upload validates decoded content, MIME and size; SVG is never accepted', async () => {
  for (const invalid of [null, {}, '', dataUrl(Buffer.from('<svg onload="alert(1)"/>')), dataUrl(png, 'jpeg'), 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'), dataUrl(Buffer.from('not an image')), dataUrl(png.subarray(0, 25))]) {
    await assert.rejects(decodeAvatarImage(invalid), /That image could not be loaded/);
  }
  await assert.rejects(decodeAvatarImage(dataUrl(Buffer.alloc(MAX_AVATAR_BYTES + 1))), error => error.status === 413);
  const huge = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(decodeAvatarImage(dataUrl(huge)), /That image could not be loaded/);
});

test('pictures above 3 MB save as bounded static PNGs without metadata', async () => {
  const original = await sharp(randomBytes(1300 * 1300 * 3), { raw: { width: 1300, height: 1300, channels: 3 } }).png().toBuffer();
  assert.ok(original.length > 3 * 1024 * 1024);
  const decoded = await decodeAvatarImage(dataUrl(original));
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.format, 'png'); assert.equal(meta.width, 1024); assert.equal(meta.height, 1024);
  assert.equal(meta.exif, undefined); assert.equal(meta.pages, undefined);
});

test('avatar image references stay within Bot data, survive reads, and become the project favicon', async t => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'bot-avatar-upload-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const bot = { slug: 'test', workspaceRoot, shape: 'cylinder', color: 'amber' };
  const patch = await avatarImagePatch(bot, { avatarImage: dataUrl(png) });
  assert.match(patch.avatarImage, /^\/api\/bots\/test\/avatar\/[a-f0-9]{64}\.png$/);
  const bytes = await readAvatarImage(bot, patch.avatarImage);
  assert.equal((await sharp(bytes).metadata()).format, 'png');
  assert.equal(await storeAvatarImage(bot, bytes), patch.avatarImage, 'identical uploads converge');
  assert.deepEqual(await avatarImagePatch({ ...bot, ...patch }, patch), patch);
  assert.deepEqual(await avatarImagePatch({ ...bot, ...patch }, { avatarImage: null }), { avatarImage: null });
  const favicon = await ensureBotFavicon({ ...bot, ...patch });
  assert.equal(favicon, avatarImageFile(patch.avatarImage));
  assert.deepEqual(await readFile(path.join(workspaceRoot, favicon)), bytes);
  for (const value of ['https://example.invalid/image.png', '/etc/passwd', patch.avatarImage.replace('/test/', '/other/'), '../avatar.svg']) {
    await assert.rejects(avatarImagePatch(bot, { avatarImage: value }), /That image could not be loaded/);
  }
  assert.equal(avatarImageFile('/etc/passwd'), null);
});

test('gateway upload persists through restart and archive, serves only PNG, and rejects invalid writes', { timeout: 60000 }, async t => {
  const { createFixture } = await import('../scripts/fixture.mjs');
  const fixture = await createFixture(); t.after(() => fixture.close());
  const original = (await fixture.request('/api/bots/alpha')).body;
  assert.equal((await fixture.request('/api/bots/alpha', 'PUT', { avatarImage: dataUrl(Buffer.from('<svg/>')) })).status, 400);
  assert.deepEqual((await fixture.request('/api/bots/alpha')).body, original);
  const saved = await fixture.request('/api/bots/alpha', 'PUT', { avatarImage: dataUrl(png) });
  assert.equal(saved.status, 200);
  const image = saved.body.avatarImage;
  const response = await fetch(fixture.url + image);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
  const stored = Buffer.from(await response.arrayBuffer());
  assert.equal((await sharp(stored).metadata()).format, 'png');
  const form = await fetch(fixture.url + '/api/bots/alpha', { method: 'PUT', body: JSON.stringify({ avatarImage: null }) });
  assert.equal(form.status, 415);
  await fixture.restart();
  assert.equal((await fixture.request('/api/bots/alpha')).body.avatarImage, image);
  assert.deepEqual(Buffer.from(await (await fetch(fixture.url + image)).arrayBuffer()), stored);
  const created = await fixture.request('/api/bots', 'POST', { name: 'Picture Bot', shape: 'blob', color: 'black', avatarImage: dataUrl(png), model: original.model });
  assert.equal(created.status, 200);
  assert.match(created.body.avatarImage, /^\/api\/bots\/picture-bot\/avatar\/[a-f0-9]{64}\.png$/);
  assert.equal((await fetch(fixture.url + created.body.avatarImage)).status, 200);
  await fixture.request('/api/main-bot', 'PUT', { slug: 'beta' });
  assert.equal((await fixture.request('/api/bots/alpha', 'DELETE')).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(fixture.url + image)).arrayBuffer()), stored);
  assert.ok((await fixture.request('/api/bot-identities')).body.bots.some(bot => bot.avatarImage === image));
});
