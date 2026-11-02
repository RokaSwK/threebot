import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';

const family = new URL('../src/lib/threadFamily.ts', import.meta.url).pathname;
const library = new URL('../src/lib/library.ts', import.meta.url).pathname;
const bundle = await build({ configFile: false, logLevel: 'silent', plugins: [{
  name: 'family-library-test',
  resolveId: id => id.endsWith('virtual:family-library-test') ? '\0family-library-test' : undefined,
  load: id => id === '\0family-library-test' ? `export * from ${JSON.stringify(family)}; export * from ${JSON.stringify(library)};` : undefined,
}], build: { ssr: 'virtual:family-library-test', write: false }, ssr: { noExternal: true } });
const entry = bundle.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry);
assert.ok(entry);
const { variantShape, threadIdentity, localAncestors, subagentTarget, subagentStatus, agentStatus, threadLink, conversationLibrary } = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const bot = { mainThreadId: 'root', name: 'App', shape: 'star', color: 'purple' };
const threads = {
  root: { id: 'root', title: 'App', lineage: { parentThreadId: null } },
  child: { id: 'child', title: 'Implement UI', lineage: { parentThreadId: 'root' } },
  nested: { id: 'nested', title: 'Check navigation', lineage: { parentThreadId: 'child' } },
};

test('children and nested subagents keep their Bot colour and change shape at each generation', () => {
  const root = threadIdentity(bot, 'root', threads);
  const child = threadIdentity(bot, 'child', threads);
  const nested = threadIdentity(bot, 'nested', threads);
  assert.equal(child.color, root.color);
  assert.equal(nested.color, root.color);
  assert.notEqual(child.shape, 'gem', 'star renders as gem, so its child must not');
  assert.notEqual(nested.shape, child.shape);
  assert.equal(child.name, 'Implement UI');
  assert.deepEqual(threadIdentity(bot, 'child', { nested: threads.nested, child: threads.child, root: threads.root }), child);
  assert.deepEqual(localAncestors('nested', threads).map(t => t.id), ['root', 'child']);
});

test('all canonical and aliased parent shapes get a different deterministic child', () => {
  for (const shape of ['blob','pebble','bean','egg','squircle','tablet','capsule','cylinder','hex','gem','crystal','wedge','shield','dome','arch','cloud','teardrop','leaf']) {
    for (const id of ['a','b','long-thread-id']) { assert.notEqual(variantShape(shape,id),shape); assert.equal(variantShape(shape,id),variantShape(shape,id)); }
  }
  assert.notEqual(variantShape('sphere','a'),'blob');
  assert.notEqual(variantShape('hexagon','a'),'hex');
});

test('remote delegates with no local child use their exact environment and thread', () => {
  const target = subagentTarget({ childThreadId: null, remoteChild: { threadId: 'mcp:launch:child', environmentId: 'mac', label: 'Air M5' } });
  assert.deepEqual(target, { kind:'remote', threadId:'mcp:launch:child', environmentId:'mac', label:'Air M5' });
  assert.equal(threadLink(target),'/api/thread-link?environmentId=mac&threadId=mcp%3Alaunch%3Achild');
  assert.deepEqual(subagentTarget({ childThreadId:'child' }), {kind:'local',threadId:'child'});
  assert.equal(subagentTarget({ childThreadId:null }),null);
  assert.equal(subagentTarget({ remoteChild:{ environmentId:42,threadId:'child' } }),null);
});

test('cancelled, stopped, failed and queued work are never labelled Done', () => {
  assert.equal(subagentStatus('completed'),'Done');
  for (const status of ['cancelled','interrupted','failed','queued','waiting']) assert.notEqual(subagentStatus(status),'Done');
});

test('settlement, native child completion and newer subagent events resolve truthfully', () => {
  const child = { status: 'idle', settledOverride: null, settledAt: null, pendingRuntimeRequest: null, updatedAt: '2026-10-30T10:00:00Z' };
  assert.equal(agentStatus({ thread: child, fallback: 'completed' }), 'completed', 'native child shells have no run status');
  assert.equal(agentStatus({ thread: { ...child, settledOverride: 'settled', settledAt: '2026-10-30T10:00:00Z' } }), 'completed');
  assert.equal(agentStatus({ thread: { ...child, settledOverride: 'active', settledAt: '2026-10-30T09:00:00Z' } }), 'idle');
  for (const status of ['running', 'waiting', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(agentStatus({ thread: { ...child, status, settledOverride: 'settled' } }), status);
  }
  assert.equal(agentStatus({ thread: { ...child, pendingRuntimeRequest: { id: 'input' }, settledOverride: 'settled' } }), 'waiting');
  assert.equal(agentStatus({ thread: { ...child, activityRunStatus: 'running', settledOverride: 'settled' } }), 'running');
  assert.equal(agentStatus({ thread: { ...child, status: 'running' }, fallback: 'completed', updatedAt: '2026-10-30T11:00:00Z' }), 'completed');
  assert.equal(subagentStatus('pending'), 'Working');
  assert.equal(subagentStatus('unexpected'), 'Unknown');
});

test('lineage cycle cannot hang rendering', () => {
  const cycle = { ...threads, root:{...threads.root,lineage:{parentThreadId:'nested'}} };
  assert.deepEqual(localAncestors('nested',cycle).map(t=>t.id),['root','child']);
});

test('Library collects actual chat links, images and files, and excludes tool output', () => {
  const at = '2026-10-30T00:00:00Z';
  const entries = conversationLibrary([
    {type:'assistant_message',text:'Read [the result](https://example.com/result). Also https://example.com/result',updatedAt:at},
    {type:'user_message',text:'',updatedAt:at,attachments:[{id:'image',name:'screen.png',mimeType:'image/png'},{id:'report',name:'report.pdf',mimeType:'application/pdf'}]},
    {type:'command_execution',text:'https://private.example/token',updatedAt:at},
  ]);
  assert.equal(entries.length,3);
  assert.deepEqual(entries.map(e=>e.kind),['link','media','file']);
  assert.equal(entries[0].href,'https://example.com/result');
  assert.deepEqual(entries[1].resource,{_tag:'attachment',attachmentId:'image'});
  assert.equal(entries[2].title,'report.pdf');
});

 test('Library removes Markdown wrappers from bold and linked URLs', () => {
   const entries = conversationLibrary([{type:'assistant_message',text:'**https://example.com** and [Repo](https://github.com/example/repo)**',updatedAt:'2026-10-30'}]);
   assert.deepEqual(entries.map(e=>e.href),['https://example.com','https://github.com/example/repo']);
 });
