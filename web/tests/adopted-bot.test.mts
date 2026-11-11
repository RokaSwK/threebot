import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOnce, entryChunk } from './support.mts';

const library = new URL('../src/lib/library.ts', import.meta.url).pathname;
const adopt = new URL('../src/lib/adopt.ts', import.meta.url).pathname;
const navigation = new URL('../src/lib/navigation.ts', import.meta.url).pathname;
const bundle = await buildOnce({ configFile: false, logLevel: 'silent', plugins: [{
  name: 'adopted-bot-test',
  resolveId: id => id.endsWith('virtual:adopted-bot-test') ? '\0adopted-bot-test' : undefined,
  load: id => id === '\0adopted-bot-test' ? [library, adopt, navigation].map((file) => `export * from ${JSON.stringify(file)};`).join('\n') : undefined,
}], build: { ssr: 'virtual:adopted-bot-test', write: false }, ssr: { noExternal: true } });
const entry = entryChunk(bundle);
assert.ok(entry);
const { botLibraryDir, workspaceListingEntries, conversationLibrary, mainThreadChoices, readNavigation } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);

test("an adopted Bot's Library is .bot/library, and its files keep their own names", () => {
  assert.equal(botLibraryDir({ adopted: true }), '.bot/library');
  assert.equal(botLibraryDir({}), 'library');
  const workspace = { workspaceRoot: '/work/repo', threadId: 'main', libraryDir: '.bot/library' };
  const entries = workspaceListingEntries({ entries: [{ path: '.bot/library/report.html', kind: 'file' }, { path: '.bot/library/sub', kind: 'directory' }] }, workspace);
  assert.deepEqual(entries.map((e: { title: string; resource: { path: string } }) => [e.title, e.resource.path]), [['report.html', '.bot/library/report.html']]);
  // A listing from outside the Bot's Library is refused, as for any Bot.
  assert.throws(() => workspaceListingEntries({ entries: [{ path: 'library/x.html', kind: 'file' }] }, workspace));
  assert.throws(() => workspaceListingEntries({ entries: [{ path: '.bot/library/x.html', kind: 'file' }] }, { workspaceRoot: '/bots/a', threadId: 'main' }));
  const linked = conversationLibrary([{ type: 'assistant_message', text: 'See [the report](.bot/library/report.html)', startedAt: '2026-01-01T00:00:00Z' }], workspace);
  assert.deepEqual(linked.map((e: { title: string }) => e.title), ['report.html']);
});

test('a project offers its own top-level, unarchived threads as the main conversation, newest first', () => {
  const thread = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'p', archivedAt: null, latestUserMessageAt: '2026-01-01T00:00:00Z', lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, ...extra });
  const choices = mainThreadChoices([
    thread('old'),
    thread('new', { latestUserMessageAt: '2026-02-01T00:00:00Z' }),
    thread('child', { lineage: { parentThreadId: 'old', relationshipToParent: 'subagent', rootThreadId: 'old' } }),
    thread('side', { lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: 'side', sideChat: true } }),
    thread('gone', { archivedAt: '2026-01-02T00:00:00Z' }),
    thread('elsewhere', { projectId: 'q' }),
  ], 'p');
  assert.deepEqual(choices.map((t: { id: string }) => t.id), ['new', 'old']);
});

test('the adopt dialog survives a reload from browser history', () => {
  assert.deepEqual(readNavigation({ view: 'overlay', slug: null, threadId: null, dialog: 'adopt-project', details: false }), { view: 'overlay', slug: null, threadId: null, dialog: 'adopt-project', details: false });
});
