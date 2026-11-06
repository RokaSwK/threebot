// T3 remains the scheduler. This stores observed dispatches and task-to-run
// references only; prompts, webhook tokens, bodies and errors are never stored.
import { promises as fs } from 'node:fs';
import path from 'node:path';
const ID = /^[\w:%.-]{1,600}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const id = (value) => typeof value === 'string' && ID.test(value) ? value : null;
const cancel = (stream) => { try { stream?.cancel(); } catch { /* A closed transport has already ended its reads. */ } };
const dispatchStatus = (value) => ({ succeeded: 'dispatched', failed: 'dispatch_failed', running: 'dispatching' })[value] ?? 'unknown';
function triggerFromMessage(messageId, taskId) {
  const prefix = `scheduled-task-message:${taskId}:`;
  if (!messageId?.startsWith(prefix)) return 'unknown';
  const tail = messageId.slice(prefix.length);
  return tail.includes(':webhook:') || tail.startsWith('webhook:') ? 'webhook' : tail.endsWith(':manual') ? 'manual' : tail.endsWith(':scheduled') ? 'scheduled' : 'unknown';
}
export function createRoutineHistory({ file, now = () => new Date().toISOString(), limit = 200 }) {
  let state; let queue = Promise.resolve(); const previous = new Map();
  const load = async () => {
    if (state) return;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); if (state.version !== 1 || !Array.isArray(state.rows) || !stamp(state.observingSince)) throw new Error('Invalid routine history file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, observingSince: now(), rows: [] }; }
  };
  const persist = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(state) + '\n', { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  };
  const serial = (work) => { const result = queue.catch(() => {}).then(async () => { await load(); return work(); }); queue = result; return result; };
  const merge = (rows) => {
    const all = new Map(state.rows.map((row) => [row.id, row]));
    for (const row of rows) all.set(row.id, row);
    const counts = new Map();
    state.rows = [...all.values()].sort((a,b) => b.at.localeCompare(a.at)).filter((row) => { const n = (counts.get(row.taskId) ?? 0) + 1; counts.set(row.taskId, n); return n <= limit; });
  };
  return {
    consumeTasks(tasks) { return serial(async () => {
      const rows = [];
      for (const task of tasks) {
        const taskId = id(task.id); if (!taskId) continue;
        const current = { lastRunAt: stamp(task.lastRunAt), status: task.lastRunStatus, count: task.runCount };
        const old = previous.get(taskId);
        // A reconnect's initial summary is not an observed run. Leave it in
        // the task summary, and recover actual executions from projections.
        if (old && current.lastRunAt && (old.lastRunAt !== current.lastRunAt || old.status !== current.status)) rows.push({ id: `dispatch:${taskId}:${current.lastRunAt}`, taskId, at: current.lastRunAt, status: dispatchStatus(current.status), trigger: 'unknown', threadId: id(task.threadId), runId: null, source: 'dispatch' });
        previous.set(taskId, current);
      }
      merge(rows); await persist();
    }); },
    consumeProjection(projection, taskIds) { return serial(async () => {
      const messages = new Map((projection.messages ?? []).filter((m) => id(m.id) && taskIds.has(m.scheduledTaskId)).map((m) => [m.id, m]));
      const rows = [];
      for (const run of projection.runs ?? []) {
        const message = messages.get(run.userMessageId);
        if (!message || !id(run.id) || !id(run.threadId) || !stamp(run.requestedAt) || typeof run.status !== 'string') continue;
        const taskId = message.scheduledTaskId;
        // No assistant text, title, errors or user-supplied data goes in this file.
        const status = TERMINAL.has(run.status) || ['queued','preparing','starting','running','waiting'].includes(run.status) ? run.status : 'unknown';
        rows.push({ id: `execution:${run.threadId}:${run.id}`, taskId, at: stamp(run.startedAt) ?? run.requestedAt, status, trigger: triggerFromMessage(message.id, taskId), threadId: run.threadId, runId: run.id, source: 'execution' });
      }
      merge(rows); if (rows.length) await persist();
    }); },
    get(taskId) { return serial(() => ({ observingSince: state.observingSince, incomplete: true, rows: state.rows.filter((row) => row.taskId === taskId) })); },
    remove(taskId) { return serial(async () => { state.rows = state.rows.filter((r) => r.taskId !== taskId); previous.delete(taskId); await persist(); }); },
  };
}

/** Register behind the gateway's existing authentication boundary. One handler
 * owns both read subscriptions; close() is available to tests/shutdown owners. */
export function createRoutineHistoryRoutes({ rpc, file, timeoutMs = 15000 }) {
  const bounded = (promise) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Routine read timed out')), timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  const history = createRoutineHistory({ file });
  let connection; let starting; let taskStream; let shellStream; let tasks = [];
  let healthy = false; let pending = Promise.resolve(); const stamps = new Map(); const threads = new Map();
  const work = new Map(); let workers = 0;
  const enqueue = (thread) => {
    if (!tasks.some((task) => task.projectId === thread.projectId) || stamps.get(thread.id) === thread.updatedAt) return;
    work.set(thread.id, thread);
    pump();
  };
  const pump = () => {
    while (workers < 2 && work.size) {
      const [key, thread] = work.entries().next().value; work.delete(key); workers++;
      void bounded(connection.call('orchestration.getThreadProjection', { threadId: key })).then(async (projection) => {
        await history.consumeProjection(projection, new Set(tasks.map((task) => task.id))); stamps.set(key, thread.updatedAt);
      }).catch(() => { healthy = false; }).finally(() => { workers--; pump(); });
    }
  };
  const ready = async () => {
    const client = await bounded(rpc());
    if (client === connection && taskStream && shellStream) return;
    if (starting) return starting;
    connection = client;
    starting = (async () => {
      cancel(taskStream); cancel(shellStream); stamps.clear(); threads.clear();
      let resolveTasks; const first = new Promise((resolve) => { resolveTasks = resolve; });
      taskStream = client.stream('scheduledTasks.subscribe', {}, (event) => {
        if (!Array.isArray(event.tasks)) return;
        const snapshot = event.tasks;
        tasks = snapshot;
        pending = pending.catch(() => {}).then(() => history.consumeTasks(snapshot));
        pending.then(() => { healthy = true; resolveTasks(); }, () => { healthy = false; resolveTasks(); });
        for (const thread of threads.values()) enqueue(thread);
      });
      let timer;
      try { await Promise.race([first, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Routine subscription timed out')), timeoutMs); })]); }
      catch (error) { cancel(taskStream); taskStream = null; throw error; }
      finally { clearTimeout(timer); }
      shellStream = client.stream('orchestration.subscribeShell', { omitIdleSubagents: true }, (event) => {
        const updated = event.kind === 'snapshot' ? event.snapshot?.threads ?? [] : event.kind === 'thread.updated' ? [event.thread] : [];
        for (const thread of updated) { threads.set(thread.id, thread); enqueue(thread); }
      });
      const stopped = () => {
        if (connection !== client) return;
        connection = null; healthy = false;
        const oldTasks = taskStream; const oldShell = shellStream;
        taskStream = null; shellStream = null;
        cancel(oldTasks); cancel(oldShell);
      };
      taskStream.done.then(stopped, stopped); shellStream.done.then(stopped, stopped);
    })().finally(() => { starting = null; });
    return starting;
  };
  return {
    history,
    async handle(req, res, url) {
      if (url.pathname !== '/api/routine-history') return false;
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(JSON.stringify({ error: 'Use GET' })); return true; }
      const taskId = id(url.searchParams.get('task'));
      if (!taskId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid routine ID' })); return true; }
      try {
        await ready(); await pending;
        if (!tasks.some((task) => task.id === taskId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Routine not found' })); return true; }
        const result = await history.get(taskId);
        res.writeHead(200); res.end(JSON.stringify({ ...result, observing: healthy }));
      } catch { res.writeHead(503); res.end(JSON.stringify({ error: 'Routine history is temporarily unavailable' })); }
      return true;
    },
    close() { cancel(taskStream); cancel(shellStream); taskStream = null; shellStream = null; },
  };
}
