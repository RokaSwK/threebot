import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnvironmentRouter, environmentPath } from './environment-routes.mts';

test('remote credentials are bound to an explicit environment and verified origin', async () => {
  const reads: string[] = [], calls: { url: string; options: RequestInit }[] = [];
  const router = createEnvironmentRouter({ local: { baseUrl: 'http://local', token: 'local-only' }, file: 'routes',
    readPrivate: async file => { reads.push(file); return file === 'routes' ? JSON.stringify({ remote: { baseUrl: 'https://peer.test', tokenFile: 'peer-token' } }) : 'remote-only'; },
    fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ environmentId: 'remote' }); },
  });
  assert.deepEqual(await router(null), { baseUrl: 'http://local', token: 'local-only' });
  assert.deepEqual(await router('remote'), { baseUrl: 'https://peer.test', token: 'remote-only' });
  assert.deepEqual(reads, ['routes', 'peer-token']);
  assert.equal(calls[0].url, 'https://peer.test/.well-known/t3/environment');
  assert.equal(calls[0].options.headers, undefined, 'identity discovery carries no credential');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(router('unknown'), { status: 403 });
});

test('missing permission, unsafe routes and identity mismatch fail closed', async () => {
  await assert.rejects(createEnvironmentRouter({ local: {} })('remote'), { status: 403 });
  for (const baseUrl of ['http://outside.test', 'https://u:p@peer.test', 'https://peer.test/path', 'https://peer.test?token=x']) {
    const router = createEnvironmentRouter({ file: 'routes', readPrivate: async () => JSON.stringify({ remote: { baseUrl } }), fetcher: () => assert.fail('must reject before fetching') });
    await assert.rejects(router('remote'), { status: 403 });
  }
  const router = createEnvironmentRouter({ file: 'routes', readPrivate: async file => file === 'routes' ? JSON.stringify({ remote: { baseUrl: 'https://peer.test', tokenFile: 'token' } }) : 'remote-only', fetcher: async () => Response.json({ environmentId: 'different' }) });
  await assert.rejects(router('remote'), { status: 502 });
  assert.deepEqual(environmentPath('/t3/environments/remote/api/assets/sample'), { environmentId: 'remote', path: '/api/assets/sample' });
  assert.deepEqual(environmentPath('/t3/ws'), { environmentId: null, path: '/ws' });
  assert.throws(() => environmentPath('/t3/environments/bad%2fid/ws'), { status: 400 });
});

test('private route and token files are required without exposing their contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bot-environment-routes-'));
  try {
    const file = path.join(root, 'routes.json');
    await writeFile(file, '{"remote":{"baseUrl":"https://peer.test","tokenFile":"private"}}', { mode: 0o644 });
    const router = createEnvironmentRouter({ file });
    await assert.rejects(router('remote'), (error: Error & { status?: number }) => error.status === 403 && !error.message.includes('private"'));
  } finally { await rm(root, { recursive: true }); }
});

test('the hand-written routes file wins over paired machines, and a routes file not written yet is empty', async () => {
  const files: Record<string, string> = {
    manual: JSON.stringify({ shared: { baseUrl: 'https://manual.test', tokenFile: 'manual-token' } }),
    paired: JSON.stringify({ shared: { baseUrl: 'https://paired.test', tokenFile: 'paired-token' }, mine: { baseUrl: 'https://mine.test', tokenFile: 'mine-token' } }),
    'manual-token': 'manual-only', 'paired-token': 'paired-only', 'mine-token': 'mine-only',
  };
  const readPrivate = async (file: string) => { if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[file]; };
  const fetcher = async (url: string) => Response.json({ environmentId: new URL(url).hostname.startsWith('mine') ? 'mine' : 'shared' });
  const router = createEnvironmentRouter({ file: ['manual', 'paired'], readPrivate, fetcher });
  assert.deepEqual(await router('shared'), { baseUrl: 'https://manual.test', token: 'manual-only' });
  assert.deepEqual(await router('mine'), { baseUrl: 'https://mine.test', token: 'mine-only' });
  const unwritten = createEnvironmentRouter({ file: [undefined, 'not-written-yet'], readPrivate, fetcher });
  await assert.rejects(unwritten('mine'), { status: 403 });
});
