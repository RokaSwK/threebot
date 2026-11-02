import assert from 'node:assert/strict';
import { build } from 'vite';
import { beforeEach, mock, test } from 'node:test';

const source = (file) => new URL(`../src/${file}`, import.meta.url).pathname;
const bundle = await build({
  configFile: false, logLevel: 'silent',
  plugins: [{
    name: 'main-bot-test-entry',
    resolveId: (id) => id.endsWith('virtual:main-bot-test') ? '\0main-bot-test' : undefined,
    load: (id) => id === '\0main-bot-test'
      ? `export { setMainBot, updateBot, deleteBot, refreshBots, saveSettings, useApp } from ${JSON.stringify(source('store.ts'))}; export { api } from ${JSON.stringify(source('lib/api.ts'))}; export { t3 } from ${JSON.stringify(source('lib/t3.ts'))};`
      : undefined,
  }],
  ssr: { noExternal: true }, build: { ssr: 'virtual:main-bot-test', write: false },
});
const entry = bundle.output.find((output) => output.type === 'chunk' && output.isEntry);
assert.ok(entry);
globalThis.localStorage = { getItem: () => null };
const { setMainBot, updateBot, deleteBot, refreshBots, saveSettings, useApp, api, t3 } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);

function bots(main = 'alpha') {
  return ['alpha', 'beta', 'gamma'].map((slug) => ({ slug, name: slug, primary: slug === main, hidden: false, pinned: false, mainThreadId: `thread-${slug}`, projectId: `project-${slug}` }));
}
const settings = { userName: 'Original', timezone: 'UTC', autoReview: true, theme: 'system', sections: [], rules: { alwaysAsk: [], allowWithoutAsking: [] } };
const deferred = () => Promise.withResolvers();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const currentMain = () => Object.values(useApp.getState().bots).filter((bot) => bot.primary).map((bot) => bot.slug);

beforeEach(() => {
  mock.restoreAll();
  useApp.setState({ bots: Object.fromEntries(bots().map((bot) => [bot.slug, bot])), historicalBots: {}, selected: 'alpha', selectedThreadId: null, exchangeBotSlug: null, settings: { ...settings } });
});

test('main replacement publishes a single authoritative snapshot after success; no transient second star', async () => {
  const pending = deferred();
  mock.method(api, 'setMainBot', () => pending.promise);
  const observed = [];
  const stop = useApp.subscribe(() => observed.push(currentMain()));
  try {
    const save = setMainBot('beta');
    await flush();
    assert.deepEqual(currentMain(), ['alpha']);
    pending.resolve({ bots: bots('beta') });
    await save;
    assert.deepEqual(currentMain(), ['beta']);
    assert.deepEqual(observed, [['beta']]);
  } finally { stop(); }
});

test('main replacement requests serialize; failure does not poison later saves', async () => {
  const first = deferred();
  const request = mock.method(api, 'setMainBot', (slug) => slug === 'beta' ? first.promise : Promise.resolve({ bots: bots(slug) }));
  const failed = setMainBot('beta');
  const next = setMainBot('gamma');
  const rejection = assert.rejects(failed, /offline/);
  await flush();
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(currentMain(), ['alpha']);
  first.reject(new Error('offline'));
  await rejection;
  await next;
  assert.deepEqual(currentMain(), ['gamma']);
});

test('polling begun before a replacement cannot restore stale stars', async () => {
  const poll = deferred();
  mock.method(api, 'bots', () => poll.promise);
  mock.method(api, 'botIdentities', async () => []);
  mock.method(api, 'setMainBot', async () => ({ bots: bots('beta') }));
  const refresh = refreshBots();
  await setMainBot('beta');
  poll.resolve(bots('alpha'));
  await refresh;
  assert.deepEqual(currentMain(), ['beta']);
});

test('legacy primary update uses the whole server list to clear the previous primary', async () => {
  mock.method(api, 'saveBot', async () => bots('beta')[1]);
  mock.method(api, 'bots', async () => bots('beta'));
  await updateBot('beta', { primary: true });
  assert.deepEqual(currentMain(), ['beta']);
});

test('refused main deletion never stops a thread or deletes a T3 project', async () => {
  mock.method(api, 'deleteBot', async () => { throw new Error('Choose another main Bot'); });
  const dispatch = mock.method(t3, 'dispatch', async () => ({}));
  const call = mock.method(t3, 'call', async () => ({}));
  await assert.rejects(deleteBot('alpha'), /Choose another/);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.equal(call.mock.callCount(), 0);
  assert.deepEqual(currentMain(), ['alpha']);
});

test('accepted deletion preserves a non-primary historical identity for old mentions', async () => {
  mock.method(api, 'deleteBot', async () => ({ ok: true, bots: bots('beta').filter((bot) => bot.slug !== 'alpha') }));
  mock.method(t3, 'dispatch', async () => ({}));
  mock.method(t3, 'call', async () => ({}));
  await deleteBot('alpha');
  assert.deepEqual(currentMain(), ['beta']);
  const historical = useApp.getState().historicalBots['archived:thread-alpha'];
  assert.equal(historical.name, 'alpha');
  assert.equal(historical.mainThreadId, 'thread-alpha');
  assert.equal(historical.primary, false);
  assert.equal(useApp.getState().selected, null);
});

test('settings PUTs serialize and publish only server-confirmed states in order', async () => {
  const first = deferred();
  const second = deferred();
  const request = mock.method(api, 'saveSettings', (patch) => 'userName' in patch ? first.promise : second.promise);
  const saveFirst = saveSettings({ userName: '  Updated  ' });
  const saveSecond = saveSettings({ timezone: 'Europe/Madrid' });
  await flush();
  assert.equal(request.mock.callCount(), 1);
  assert.equal(useApp.getState().settings.userName, 'Original');
  first.resolve({ ...settings, userName: 'Updated' });
  await saveFirst;
  assert.equal(useApp.getState().settings.userName, 'Updated');
  await flush();
  assert.equal(request.mock.callCount(), 2);
  assert.equal(useApp.getState().settings.timezone, 'UTC');
  second.resolve({ ...settings, userName: 'Updated', timezone: 'Europe/Madrid' });
  await saveSecond;
  assert.equal(useApp.getState().settings.userName, 'Updated');
  assert.equal(useApp.getState().settings.timezone, 'Europe/Madrid');
  assert.deepEqual(request.mock.calls.map((call) => call.arguments[0]), [{ userName: '  Updated  ' }, { timezone: 'Europe/Madrid' }]);
});

test('settings failure refetches the committed value, rejects to the UI, and lets the next save proceed', async () => {
  const confirmed = { ...settings, userName: 'Committed before disconnect' };
  mock.method(api, 'saveSettings', async (patch) => {
    if ('userName' in patch) throw new Error('Connection lost');
    return { ...confirmed, ...patch };
  });
  const refetch = mock.method(api, 'settings', async () => confirmed);
  const failed = saveSettings({ userName: 'Unconfirmed' });
  const next = saveSettings({ timezone: 'Europe/Madrid' });
  await assert.rejects(failed, /Connection lost/);
  assert.equal(refetch.mock.callCount(), 1);
  await next;
  assert.equal(useApp.getState().settings.userName, 'Committed before disconnect');
  assert.equal(useApp.getState().settings.timezone, 'Europe/Madrid');
});

test('failed PUT plus failed refetch retains last confirmed settings and still rejects', async () => {
  mock.method(api, 'saveSettings', async () => { throw new Error('offline'); });
  mock.method(api, 'settings', async () => { throw new Error('offline'); });
  await assert.rejects(saveSettings({ userName: 'Unconfirmed' }), /offline/);
  assert.deepEqual(useApp.getState().settings, settings);
});
