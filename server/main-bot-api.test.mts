import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// This gateway only sees temporary fixture directories and an unreachable local T3 port.
// It never reads real credentials, connects to a real T3, or changes a user's Bots.
test('gateway main-Bot endpoints persist replacement and reject unsafe hides/deletes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'main-bot-api-'));
  const botsRoot = path.join(root, 'bots');
  for (const slug of ['alpha', 'beta']) {
    const dir = path.join(botsRoot, slug, '.bot');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bot.json'), JSON.stringify({ name: slug, mainThreadId: `thread-${slug}`, primary: true, createdAt: '2026-01-01T00:00:00Z' }));
  }
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  let processHandle;
  try {
    const start = async () => {
      processHandle = spawn(process.execPath, [new URL('./gateway.mts', import.meta.url).pathname], {
        env: {
          PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, 'codex'),
          HOST: '127.0.0.1', PORT: String(port), BOTS_ROOT: botsRoot, T3_URL: 'http://127.0.0.1:1',
          T3_TOKEN: 'fixture-only', BOT_MCP_TOKEN: 'fixture-only', BOT_PASSWORD: '',
          VAULT_FILE: path.join(root, 'vault.enc'), VAULT_KEY_FILE: path.join(root, 'vault-key'),
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      processHandle.stderr.on('data', () => {});
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fixture gateway did not start')), 5000);
        processHandle.once('error', (error) => { clearTimeout(timeout); reject(error); });
        processHandle.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`fixture gateway exited ${code}`)); });
        processHandle.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('bot gateway on')) { clearTimeout(timeout); resolve(); }
        });
      });
    };
    const stop = async () => {
      const exited = once(processHandle, 'exit');
      processHandle.kill();
      await exited;
    };
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const main = (bots) => bots.filter((bot) => bot.primary).map((bot) => bot.slug);
    await start();
    assert.deepEqual(main((await request('/api/bots')).body.bots), ['alpha']);
    const replacement = await request('/api/main-bot', 'PUT', { slug: 'beta' });
    assert.equal(replacement.status, 200);
    assert.deepEqual(main(replacement.body.bots), ['beta']);
    assert.equal((await request('/api/bots/alpha')).body.primary, false);
    assert.equal((await request('/api/bots/beta')).body.primary, true);
    assert.equal((await request('/api/bots/beta', 'PUT', { hidden: true })).status, 409);
    assert.equal((await request('/api/bots/beta', 'DELETE')).status, 409);
    assert.equal((await request('/api/main-bot', 'PUT', { slug: 'missing' })).status, 404);
    assert.equal((await request('/api/main-bot', 'PUT', null)).status, 400);
    assert.equal((await request('/api/bots/missing', 'PUT', { primary: true })).status, 404);
    assert.deepEqual(main((await request('/api/bots')).body.bots), ['beta']);
    const instructions = await readFile(path.join(botsRoot, 'alpha/AGENTS.md'), 'utf8');
    assert.doesNotMatch(instructions, /You are the primary Bot/);
    assert.match(await readFile(path.join(botsRoot, 'beta/AGENTS.md'), 'utf8'), /You are the primary Bot/);
    await stop();
    await start();
    assert.deepEqual(main((await request('/api/bots')).body.bots), ['beta']);
    assert.equal((await request('/api/bots/alpha', 'DELETE')).status, 200);
    const archived = (await request('/api/bot-identities')).body.bots;
    assert.equal(archived[0].name, 'alpha');
    assert.equal(archived[0].mainThreadId, 'thread-alpha');
    assert.equal(archived[0].primary, false);
    assert.equal((await request('/api/bots/beta', 'DELETE')).status, 200);
    assert.deepEqual((await request('/api/bots')).body.bots, []);
    await stop();
    processHandle = null;
  } finally {
    if (processHandle && processHandle.exitCode === null) {
      const exited = once(processHandle, 'exit');
      processHandle.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
