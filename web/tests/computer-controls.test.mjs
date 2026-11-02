import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { build } from 'vite';
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = new Window({ url: 'https://bot.example/' });
for (const key of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const sockets = [];
class Socket {
  static OPEN = 1; readyState = 1; messages = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(value) { this.messages.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
globalThis.WebSocket = Socket;
const directory = await mkdtemp(join(tmpdir(), 'bot-computer-controls-'));
const source = new URL('../src/components/Computer.tsx', import.meta.url).pathname;
const bundle = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, ssr: { noExternal: true },
  plugins: [{ name: 'computer-test', resolveId: id => id.endsWith('virtual:computer-test') ? '\0computer-test' : undefined,
    load: id => id === '\0computer-test' ? `export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { ComputerScreen } from ${JSON.stringify(source)};` : undefined }],
  build: { ssr: 'virtual:computer-test', write: false, rollupOptions: { output: { entryFileNames: 'entry.mjs', chunkFileNames: '[name]-[hash].mjs' } } } });
for (const output of bundle.output) { const path = join(directory, output.fileName); await mkdir(dirname(path), { recursive: true }); await writeFile(path, output.type === 'chunk' ? output.code : output.source); }
const { createElement: h, act, createRoot, ComputerScreen } = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
let root, host, image, socket;
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async fn => act(async () => { fn(); await flush(); });
const inputs = () => socket.messages.filter(message => !['ack', 'takeControl', 'releaseControl'].includes(message.type));
async function render(interactive = true) {
  await settle(() => root.render(h(ComputerScreen, { threadId: 'thread', tabId: 'tab', interactive })));
  socket = sockets.at(-1); image = host.querySelector('img');
  image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 400 });
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1600 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1000 });
  await settle(() => socket.receive({ type: 'viewport', width: 1280, height: 800 }));
}
const control = (controller = 'you', canOperate = true) => settle(() => socket.receive({ type: 'control', controller, canOperate, generation: 1, dialog: null }));
async function pointer(type, x, y, options = {}) {
  const { timeStamp, ...init } = options;
  const event = new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0, ...init });
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  await settle(() => image.dispatchEvent(event));
}
beforeEach(() => { sockets.length = 0; host = document.createElement('main'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await settle(() => root.unmount()); document.body.replaceChildren(); });
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(directory, { recursive: true }); });

test('pointer coordinates use the contained frame and never hit letterboxing', async () => {
  await render(); await control();
  await pointer('pointerdown', 110, 145); await pointer('pointerup', 110, 145);
  assert.deepEqual(inputs().map(({ action, x, y }) => ({ action, x, y })), [{ action: 'down', x: 320, y: 160 }, { action: 'up', x: 320, y: 160 }]);
  socket.messages.length = 0;
  await pointer('pointerdown', 110, 40); await pointer('pointerup', 110, 40);
  assert.equal(inputs().length, 0);
});

test('Watching and unacknowledged control never forward input', async () => {
  await render(); await control('agent');
  await pointer('pointerdown', 110, 145);
  await settle(() => image.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA' })));
  assert.equal(inputs().length, 0);
  assert.equal(socket.messages.filter(message => message.type === 'takeControl').length, 1);
  await control(); await pointer('pointerdown', 110, 145);
  assert.equal(inputs().length, 1);
  await settle(() => root.render(h(ComputerScreen, { threadId: 'thread', tabId: 'tab', interactive: false })));
  const watcher = sockets.at(-1); socket = watcher; await control('you');
  image = host.querySelector('img'); await pointer('pointerdown', 110, 145);
  assert.equal(inputs().length, 0); assert.equal(watcher.messages.length, 0);
});

test('touch tap clicks once, touch pan scrolls scaled pixels, and cancellation releases a mouse press', async () => {
  await render(); await control();
  await pointer('pointerdown', 110, 145, { pointerType: 'touch' }); await pointer('pointerup', 110, 145, { pointerType: 'touch' });
  assert.deepEqual(inputs().filter(message => message.type === 'mouse').map(message => message.action), ['move', 'down', 'up']);
  await settle(() => image.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 110, clientY: 145, buttons: 1 })));
  assert.equal(inputs().filter(message => message.action === 'down').length, 1);
  socket.messages.length = 0;
  await pointer('pointerdown', 110, 245, { pointerType: 'touch' });
  await pointer('pointermove', 110, 220, { pointerType: 'touch' }); await pointer('pointerup', 110, 220, { pointerType: 'touch' });
  assert.deepEqual(inputs().map(({ type, deltaX, deltaY }) => ({ type, deltaX, deltaY })), [{ type: 'wheel', deltaX: 0, deltaY: 80 }]);
  socket.messages.length = 0;
  await pointer('pointerdown', 110, 145); await pointer('pointercancel', 110, 40);
  assert.deepEqual(inputs().map(message => [message.action, message.buttons, message.x, message.y]), [['down', 1, 320, 160], ['up', 0, 320, 160]]);
});

test('native mobile text entry sends composed text once and explicit keys use the server protocol', async () => {
  await render(); await control();
  const input = host.querySelector('[aria-label="Type on computer"]'); assert.ok(input);
  await settle(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'Café 👋'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  assert.equal(inputs().length, 0);
  await settle(() => input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(inputs(), [{ type: 'text', text: 'Café 👋' }]);
  assert.equal(input.value, '');
  await settle(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Enter').click());
  assert.deepEqual(inputs().slice(1).map(({ type, action, key, code, keyCode }) => ({ type, action, key, code, keyCode })), [{ type: 'key', action: 'down', key: 'Enter', code: 'Enter', keyCode: 13 }, { type: 'key', action: 'up', key: 'Enter', code: 'Enter', keyCode: 13 }]);
  await control('another-viewer'); assert.equal(host.querySelector('[aria-label="Type on computer"]'), null);
});

test('portrait frames, wheel units, held keys, and disconnect preserve correct input state', async () => {
  await render(); await control();
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 500 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1000 });
  await pointer('pointerdown', 160, 120); await pointer('pointerup', 160, 120);
  assert.deepEqual(inputs().map(({ x, y }) => ({ x, y })), [{ x: 320, y: 200 }, { x: 320, y: 200 }]);
  await pointer('pointerdown', 40, 120); assert.equal(inputs().length, 2);
  await settle(() => image.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 160, clientY: 120, deltaY: 3, deltaMode: 1 })));
  assert.equal(inputs().at(-1).deltaY, 48);
  await settle(() => image.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true, keyCode: 16 })));
  await pointer('pointerdown', 160, 120);
  await settle(() => image.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  assert.deepEqual(inputs().slice(-2).map(message => [message.type, message.action, message.buttons ?? message.key]), [['mouse', 'up', 0], ['key', 'up', 'Shift']]);
  await settle(() => root.unmount());
  assert.equal(socket.messages.at(-1).type, 'releaseControl');
  assert.equal(socket.readyState, 3);
});

test('read-only capability never claims control; frame load acknowledges only the current socket', async () => {
  await render(); await control('unclaimed', false);
  assert.equal(socket.messages.length, 0);
  assert.equal(host.querySelector('input'), null);
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, revoked = [];
  URL.createObjectURL = () => 'blob:test-frame'; URL.revokeObjectURL = url => revoked.push(url);
  try {
    await settle(() => socket.onmessage({ data: new Blob(['frame'], { type: 'image/jpeg' }) }));
    assert.equal(socket.messages.length, 0);
    await settle(() => image.onload());
    assert.deepEqual(socket.messages, [{ type: 'ack' }]);
    await settle(() => root.unmount());
    await settle(() => image.onload());
    assert.deepEqual(socket.messages, [{ type: 'ack' }]);
    assert.deepEqual(revoked, ['blob:test-frame']);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});

const editor = () => host.querySelector('[aria-label="Type on computer"]');
const editText = value => settle(() => {
  const field = editor(); assert.ok(field);
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, value);
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const submitText = () => settle(() => editor().closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
const paste = text => settle(() => {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  image.dispatchEvent(event);
});
const clickAt = async (x, y, time, init = {}) => { await pointer('pointerdown', x, y, { ...init, timeStamp: time }); await pointer('pointerup', x, y, { ...init, timeStamp: time + 10 }); await pointer('lostpointercapture', x, y, { ...init, timeStamp: time + 11 }); };
const clickCounts = () => inputs().filter(message => ['down', 'up'].includes(message.action)).map(message => message.clickCount);

test('mouse and touch double/triple clicks retain the same click count on press and release', async () => {
  await render(); await control();
  await clickAt(110, 145, 1000); await clickAt(110, 145, 1200); await clickAt(111, 145, 1400);
  assert.deepEqual(clickCounts(), [1, 1, 2, 2, 3, 3]);
  socket.messages.length = 0;
  await clickAt(110, 145, 3000, { pointerType: 'touch' }); await clickAt(110, 145, 3200, { pointerType: 'touch' });
  assert.deepEqual(clickCounts(), [1, 1, 2, 2]);
});

test('multi-click sequence resets on time, movement, button, drag, cancellation, and tab switch', async () => {
  await render(); await control();
  await clickAt(110, 145, 1000); await clickAt(110, 145, 1200);
  await clickAt(110, 145, 1800); await clickAt(120, 145, 2000);
  await clickAt(120, 145, 2200, { button: 2, buttons: 2 });
  assert.deepEqual(clickCounts(), [1, 1, 2, 2, 1, 1, 1, 1, 1, 1]);
  socket.messages.length = 0;
  await pointer('pointerdown', 120, 145, { timeStamp: 2400, button: 2, buttons: 2 });
  await pointer('pointermove', 140, 145, { timeStamp: 2410, button: 2, buttons: 2 });
  await pointer('pointerup', 140, 145, { timeStamp: 2420, button: 2 });
  await clickAt(140, 145, 2600, { button: 2, buttons: 2 });
  assert.deepEqual(clickCounts(), [2, 2, 1, 1]);
  await pointer('pointerdown', 140, 145, { timeStamp: 2800, button: 2, buttons: 2 });
  await pointer('pointercancel', 140, 145, { timeStamp: 2810 });
  await clickAt(140, 145, 3000, { button: 2, buttons: 2 });
  assert.deepEqual(clickCounts().slice(-4), [2, 2, 1, 1]);
  await settle(() => root.render(h(ComputerScreen, { threadId: 'thread', tabId: 'other-tab', interactive: true })));
  socket = sockets.at(-1); image = host.querySelector('img'); await control();
  await clickAt(140, 145, 3200, { button: 2, buttons: 2 }); assert.deepEqual(clickCounts(), [1, 1]);
});

test('over-limit text stays complete until edited within the server limit, including emoji boundaries', async () => {
  await render(); await control(); const oversized = `${'a'.repeat(9999)}👋`;
  await editText(oversized); await submitText();
  assert.equal(inputs().length, 0); assert.equal(editor().value, oversized);
  assert.equal(editor().getAttribute('aria-invalid'), 'true'); assert.match(host.textContent, /10,001.*10,000/);
  const send = [...host.querySelectorAll('button')].find(button => button.textContent === 'Send'); assert.equal(send.disabled, true);
  const valid = `${'a'.repeat(9998)}👋`; await editText(valid); await submitText();
  assert.deepEqual(inputs(), [{ type: 'text', text: valid }]); assert.equal(editor().value, '');
});

test('direct paste preserves oversized text in the editor rather than sending a truncated value', async () => {
  await render(); await control(); const oversized = `${'a'.repeat(9999)}👋`;
  await paste(oversized); assert.equal(inputs().length, 0); assert.equal(editor().value, oversized);
  await editText('Unsent draft\n'); await paste(oversized);
  assert.equal(editor().value, `Unsent draft\n${oversized}`); assert.equal(inputs().length, 0);
});

test('text remains editable when the socket closes or ownership changes before the next render', async () => {
  await render(); await control(); await editText('Keep this text');
  socket.readyState = 3; await submitText();
  assert.equal(editor().value, 'Keep this text'); assert.equal(inputs().length, 0);
  socket.readyState = 1;
  await act(async () => {
    socket.receive({ type: 'control', canOperate: true, controller: 'another-viewer', generation: 2, dialog: null });
    editor().closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.equal(editor().value, 'Keep this text'); assert.equal(inputs().length, 0);
  await control(); await submitText(); assert.deepEqual(inputs(), [{ type: 'text', text: 'Keep this text' }]);
});

test('socket send failures preserve the complete draft and rejected direct paste', async () => {
  await render(); await control(); await editText('Keep\nthis 👋');
  const send = socket.send; socket.send = () => { throw new Error('Socket unavailable'); };
  await submitText(); assert.equal(editor().value, 'Keep\nthis 👋'); assert.equal(inputs().length, 0);
  assert.match(host.textContent, /Text wasn't sent/);
  await paste(' plus pasted text'); assert.equal(editor().value, 'Keep\nthis 👋 plus pasted text'); assert.equal(inputs().length, 0);
  socket.send = send; await submitText();
  assert.deepEqual(inputs(), [{ type: 'text', text: 'Keep\nthis 👋 plus pasted text' }]); assert.equal(editor().value, '');
});

test('browser address navigation requires ownership and validates the URL without losing edits', async () => {
  await render();
  assert.equal(host.querySelector('[aria-label="Browser address"]'), null);
  await control();
  const address = host.querySelector('[aria-label="Browser address"]');
  const edit = value => settle(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(address), 'value').set.call(address, value);
    address.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const submit = () => settle(() => address.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await edit('javascript:alert(1)'); await submit();
  assert.equal(inputs().length, 0); assert.equal(address.value, 'javascript:alert(1)'); assert.equal(address.getAttribute('aria-invalid'), 'true');
  await edit('example.test/path'); await submit();
  assert.deepEqual(inputs(), [{ type: 'navigate', url: 'https://example.test/path' }]);
  socket.messages.length = 0;
  await act(async () => {
    socket.receive({ type: 'control', canOperate: true, controller: 'another-viewer', generation: 2 });
    address.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush();
  });
  assert.equal(inputs().length, 0);
});
