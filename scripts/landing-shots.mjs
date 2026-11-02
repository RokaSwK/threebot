#!/usr/bin/env node
// Product screenshots for the public landing page. Runs the real built app against
// the disposable "landing" fixture in a separate headless Chrome profile. Nothing
// here touches a signed-in account, the live site or a real T3.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixture } from './fixture.mjs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = path.resolve(process.argv[2] ?? 'web/public/welcome/img');
await mkdir(out, { recursive: true });
const fixture = await createFixture({ scenario: 'landing' });
const profile = await mkdtemp(path.join(tmpdir(), 'pingbot-landing-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let latest;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { latest = error; }
    await wait(100);
  }
  throw new Error(`Timed out: ${label}${latest ? ` (${latest.message})` : ''}`);
}
let socket;
try {
  const environment = await until(async () => { const response = await fetch(new URL('/t3/.well-known/t3/environment', fixture.url)); return response.ok ? response.json() : null; }, 'fixture');
  if (environment.label !== 'Disposable local fixture (fake T3)') throw new Error('Refusing a non-fixture account');
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome debugger');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let next = 0; const pending = new Map();
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result)); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? '')); return result.value; };
  await cdp('Page.enable'); await cdp('Runtime.enable');

  let scale = 2;
  const viewport = async (width, height, deviceScaleFactor, mobile) => { scale = deviceScaleFactor; await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height }); await cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile }); };
  const open = async (hash = '') => { await cdp('Page.navigate', { url: fixture.url + '/' + hash }); await until(() => evaluate('!!document.querySelector(".bot-sidebar, .mobile-home, .chat-view")'), 'app shell'); await evaluate('document.fonts.ready'); await wait(1800); };
  const click = async (selector) => {
    const point = await until(() => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`), `click target ${selector}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const settle = async (ms = 900) => { await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'); await wait(ms); };
  const shot = async (name, clip) => {
    const params = { format: 'webp', quality: 92 };
    if (clip) {
      const rect = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(clip.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      if (!rect) throw new Error(`No element for ${clip.selector}`);
      const pad = clip.pad ?? 0;
      params.clip = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale };
    }
    const { data } = await cdp('Page.captureScreenshot', params);
    await writeFile(path.join(out, `${name}.webp`), Buffer.from(data, 'base64'));
    console.log('saved', name);
  };
  const escape = async () => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(400); };

  for (const theme of ['dark']) {
    await fixture.request('/api/settings', 'PUT', { theme });

    // Desktop
    await viewport(1440, 900, 2, false);
    await open();
    await click('[aria-label="Morning, main Bot"]');
    await until(() => evaluate('!!document.querySelector(".chat-view .bubble")'), 'Morning chat');
    await settle();
    await shot(`desktop-morning-${theme}`);
    await click('[title="Hide details"]');
    await settle(700);
    await shot(`desktop-hero-${theme}`);
    await click('[title="Show details"]');
    await settle(500);
    await click('[aria-label="Money"]');
    await until(() => evaluate('!!document.querySelector(".question-card")'), 'Money question card');
    await settle();
    await shot(`desktop-money-${theme}`);
    await shot(`crop-question-${theme}`, { selector: '.question-card', pad: 4 });
    await shot(`crop-routines-${theme}`, { selector: '.routine-section', pad: 16 });
    if (theme === 'dark') {
      await click('[aria-label="Search"]');
      await until(() => evaluate('!!document.querySelector("[role=dialog] input")'), 'search dialog');
      await cdp('Input.insertText', { text: 'lisbon' });
      await wait(1200); await settle(400);
      await shot('crop-search', { selector: '[role=dialog]', pad: 0 });
      await escape();
      await click('[aria-label="New Bot"]');
      await until(() => evaluate('!!document.querySelector("[role=dialog]")'), 'new bot dialog');
      await settle(700);
      await shot('crop-new-bot', { selector: '[role=dialog]', pad: 0 });
      await escape();
    }

    // Phone
    await viewport(412, 915, 3, true);
    await open();
    // The app may reopen a chat; the Home screen is what we want first.
    if (await evaluate('!!document.querySelector(".chat-view [aria-label=Back]")')) { await click('.chat-view [aria-label="Back"]'); await wait(600); }
    await until(() => evaluate('!!document.querySelector(".mobile-home [aria-label=\'Morning, main Bot\']")'), 'phone home');
    await settle();
    await shot(`phone-home-${theme}`);
    await click('[aria-label="Morning, main Bot"]');
    await until(() => evaluate('!!document.querySelector(".chat-view .bubble")'), 'phone Morning chat');
    await settle();
    await shot(`phone-morning-${theme}`);
    await click('[aria-label="Back"]');
    await until(() => evaluate('!!document.querySelector(".mobile-home")'), 'phone home again');
    await click('[aria-label="Money"]');
    await until(() => evaluate('!!document.querySelector(".question-card")'), 'phone Money question');
    await settle();
    await shot(`phone-money-${theme}`);
  }
} finally {
  socket?.close();
  chrome.kill();
  await fixture.close();
  await rm(profile, { recursive: true, force: true });
}
