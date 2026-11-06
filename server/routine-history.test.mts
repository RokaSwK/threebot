import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRoutineHistory, createRoutineHistoryRoutes } from './routine-history.mts';
const task = { id: 'task-1', projectId: 'project', threadId: 'thread', lastRunAt: '2026-10-31T12:00:00Z', lastRunStatus: 'succeeded', runCount: 12 };
const projection = (status = 'completed') => ({ messages: [{ id: 'scheduled-task-message:task-1:123:manual', scheduledTaskId: 'task-1', text: 'PRIVATE PROMPT AND TOKEN' }], runs: [{ id: 'run-1', threadId: 'thread', userMessageId: 'scheduled-task-message:task-1:123:manual', requestedAt: '2026-10-31T12:00:00Z', startedAt: '2026-10-31T12:00:01Z', status }] });
async function fixture(t, options = {}) { const root = await mkdtemp(join(tmpdir(), 'routine-history-test-')); t.after(() => rm(root, { recursive: true, force: true })); const file = join(root, 'history.json'); return { file, history: createRoutineHistory({ file, ...options }) }; }
test('initial summary is not fabricated history; subsequent dispatch differs from execution', async (t) => {
  const { history, file } = await fixture(t);
  await history.consumeTasks([task]); assert.deepEqual((await history.get(task.id)).rows, []);
  await history.consumeTasks([{ ...task, lastRunAt: '2026-10-31T13:00:00Z', runCount: 13 }]);
  let rows = (await history.get(task.id)).rows; assert.equal(rows[0].status, 'dispatched'); assert.equal(rows[0].source, 'dispatch'); assert.equal(rows[0].runId, null);
  await history.consumeProjection(projection('running'), new Set([task.id]));
  await history.consumeProjection(projection(), new Set([task.id]));
  rows = (await history.get(task.id)).rows; assert.equal(rows.length, 2); assert.equal(rows[1].status, 'completed'); assert.equal(rows[1].trigger, 'manual'); assert.equal(rows[1].runId, 'run-1');
  assert.ok(!(await readFile(file, 'utf8')).includes('PRIVATE'));
  assert.deepEqual(await createRoutineHistory({ file }).get(task.id), await history.get(task.id));
});
test('run references require explicit scheduledTaskId and matching userMessageId', async (t) => {
  const { history } = await fixture(t);
  const p = projection(); p.messages[0].scheduledTaskId = 'other-task';
  await history.consumeProjection(p, new Set([task.id])); assert.equal((await history.get(task.id)).rows.length, 0);
  p.messages[0].scheduledTaskId = task.id; p.runs[0].userMessageId = 'unrelated';
  await history.consumeProjection(p, new Set([task.id])); assert.equal((await history.get(task.id)).rows.length, 0);
});
test('concurrent writes merge, bound retention per task and keep skipped/failed/cancelled distinct', async (t) => {
  const { history } = await fixture(t, { limit: 2 });
  await Promise.all(['completed','failed','cancelled'].map((status, n) => { const p = projection(status); p.runs[0].id += n; p.runs[0].startedAt = `2026-10-31T12:0${n}:01Z`; return history.consumeProjection(p, new Set([task.id])); }));
  const result = await history.get(task.id); assert.equal(result.incomplete, true); assert.deepEqual(result.rows.map(r=>r.status), ['cancelled','failed']);
  // Never infer a skipped timer or agent completion from a counter alone.
  await history.consumeTasks([task]); await history.consumeTasks([{...task, runCount: 99}]); assert.equal((await history.get(task.id)).rows.length, 2);
  await history.remove(task.id); assert.equal((await history.get(task.id)).rows.length, 0);
});
test('gateway handler subscribes read-only, records linked executions and rejects invalid requests', async (t) => {
  const { file } = await fixture(t); const calls = []; const listeners = new Map();
  const client = {
    stream(tag, payload, onItem) { calls.push(tag); listeners.set(tag, onItem); queueMicrotask(() => onItem(tag === 'scheduledTasks.subscribe' ? { tasks: [task] } : { kind: 'snapshot', snapshot: { threads: [{ id: 'thread', projectId: 'project', updatedAt: 'now' }] } })); return { cancel() {}, done: new Promise(() => {}) }; },
    async call(tag) { calls.push(tag); assert.equal(tag, 'orchestration.getThreadProjection'); return projection(); },
  };
  const routes = createRoutineHistoryRoutes({ rpc: async () => client, file });
  const server = http.createServer(async (req,res) => { if (!(await routes.handle(req,res,new URL(req.url,'http://localhost')))) { res.writeHead(404); res.end(); } }); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => { routes.close(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/routine-history`;
  assert.equal((await fetch(url)).status, 400); assert.equal((await fetch(url+'?task=task-1',{method:'POST'})).status, 405);
  let response = await fetch(url+'?task=task-1'); assert.equal(response.status, 200);
  response = await fetch(url+'?task=task-1'); const result = await response.json(); assert.equal(result.rows[0].status,'completed');
  assert.equal((await fetch(url+'?task=missing')).status,404);
  assert.deepEqual([...new Set(calls)].sort(), ['orchestration.getThreadProjection','orchestration.subscribeShell','scheduledTasks.subscribe']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
