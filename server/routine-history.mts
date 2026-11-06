// T3 remains the scheduler. This stores observed dispatches and task-to-run
// references only; prompts, webhook tokens, bodies and errors are never stored.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A scheduled task from T3's `scheduledTasks.subscribe`, as far as this file reads it. */
export type RoutineTask = { id: string; projectId?: string | null; threadId?: string | null; lastRunAt?: string | null; lastRunStatus?: string | null; runCount?: number };
/** A message of T3's thread projection; `scheduledTaskId` is absent on ordinary messages. */
type ProjectionMessage = { id: string; scheduledTaskId?: string | null };
type ProjectionRun = { id: string; threadId: string; userMessageId: string; requestedAt: string; startedAt?: string | null; status: unknown };
/** The parts of T3's `orchestration.getThreadProjection` result that point a run at a routine. */
export type RoutineProjection = { messages?: ProjectionMessage[] | null; runs?: ProjectionRun[] | null };
/** One observed dispatch or execution. Only references, never content. */
export type RoutineHistoryRow = {
  id: string;
  taskId: string;
  at: string;
  status: string;
  trigger: 'webhook' | 'manual' | 'scheduled' | 'unknown';
  threadId: string | null;
  runId: string | null;
  source: 'dispatch' | 'execution';
};
type RoutineHistoryState = { version: 1; observingSince: string; rows: RoutineHistoryRow[] };
/** A thread from T3's shell subscription. */
type ShellThread = { id: string; projectId?: string | null; updatedAt?: string | null };
type TaskEvent = { tasks?: RoutineTask[] };
/** `thread` is set on `thread.updated`, `snapshot` on `snapshot`. */
type ShellEvent = { kind?: string; snapshot?: { threads?: ShellThread[] | null } | null; thread: ShellThread };
type RpcStream = { done: Promise<unknown>; cancel(): void };
/** The T3 RPC connection this needs (T3Client fits). Stream events are T3's JSON. */
export type RoutineRpcClient = {
  call(tag: string, payload: Record<string, unknown>): Promise<unknown>;
  stream(tag: string, payload: Record<string, unknown>, onItem: (event: any) => void): RpcStream;
};

const ID = /^[\w:%.-]{1,600}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const stamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const id = (value: unknown): string | null => typeof value === 'string' && ID.test(value) ? value : null;
const cancel = (stream: RpcStream | null | undefined) => { try { stream?.cancel(); } catch { /* A closed transport has already ended its reads. */ } };
const dispatchStatus = (value: string | null | undefined): string => ({ succeeded: 'dispatched', failed: 'dispatch_failed', running: 'dispatching' } as Partial<Record<string, string>>)[value as string] ?? 'unknown';
function triggerFromMessage(messageId: string | null | undefined, taskId: string): RoutineHistoryRow['trigger'] {
  const prefix = `scheduled-task-message:${taskId}:`;
  if (!messageId?.startsWith(prefix)) return 'unknown';
  const tail = messageId.slice(prefix.length);
  return tail.includes(':webhook:') || tail.startsWith('webhook:') ? 'webhook' : tail.endsWith(':manual') ? 'manual' : tail.endsWith(':scheduled') ? 'scheduled' : 'unknown';
}
export function createRoutineHistory({ file, now = () => new Date().toISOString(), limit = 200 }: { file: string; now?: () => string; limit?: number }) {
  // Every reader goes through serial(), which loads it first.
  let state!: RoutineHistoryState; let queue: Promise<unknown> = Promise.resolve(); const previous = new Map<string, { lastRunAt: string | null; status: string | null | undefined; count: number | undefined }>();
  const load = async (): Promise<void> => {
    if (state) return;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); if (state.version !== 1 || !Array.isArray(state.rows) || !stamp(state.observingSince)) throw new Error('Invalid routine history file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = { version: 1, observingSince: now(), rows: [] }; }
  };
  const persist = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(state) + '\n', { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  };
  const serial = <T,>(work: () => T | Promise<T>): Promise<T> => { const result = queue.catch(() => {}).then(async () => { await load(); return work(); }); queue = result; return result; };
  const merge = (rows: RoutineHistoryRow[]) => {
    const all = new Map(state.rows.map((row) => [row.id, row]));
    for (const row of rows) all.set(row.id, row);
    const counts = new Map<string, number>();
    state.rows = [...all.values()].sort((a,b) => b.at.localeCompare(a.at)).filter((row) => { const n = (counts.get(row.taskId) ?? 0) + 1; counts.set(row.taskId, n); return n <= limit; });
  };
  return {
    consumeTasks(tasks: RoutineTask[]) { return serial(async () => {
      const rows: RoutineHistoryRow[] = [];
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
    consumeProjection(projection: RoutineProjection, taskIds: ReadonlySet<string>) { return serial(async () => {
      const messages = new Map((projection.messages ?? []).filter((m) => id(m.id) && taskIds.has(m.scheduledTaskId as string)).map((m) => [m.id, m]));
      const rows: RoutineHistoryRow[] = [];
      for (const run of projection.runs ?? []) {
        const message = messages.get(run.userMessageId);
        if (!message || !id(run.id) || !id(run.threadId) || !stamp(run.requestedAt) || typeof run.status !== 'string') continue;
        // Kept above only when it is one of taskIds.
        const taskId = message.scheduledTaskId as string;
        // No assistant text, title, errors or user-supplied data goes in this file.
        const status = TERMINAL.has(run.status) || ['queued','preparing','starting','running','waiting'].includes(run.status) ? run.status : 'unknown';
        rows.push({ id: `execution:${run.threadId}:${run.id}`, taskId, at: stamp(run.startedAt) ?? run.requestedAt, status, trigger: triggerFromMessage(message.id, taskId), threadId: run.threadId, runId: run.id, source: 'execution' });
      }
      merge(rows); if (rows.length) await persist();
    }); },
    get(taskId: string) { return serial(() => ({ observingSince: state.observingSince, incomplete: true, rows: state.rows.filter((row) => row.taskId === taskId) })); },
    remove(taskId: string) { return serial(async () => { state.rows = state.rows.filter((r) => r.taskId !== taskId); previous.delete(taskId); await persist(); }); },
  };
}

/** Register behind the gateway's existing authentication boundary. One handler
 * owns both read subscriptions; close() is available to tests/shutdown owners. */
export function createRoutineHistoryRoutes({ rpc, file, timeoutMs = 15000 }: { rpc: () => Promise<RoutineRpcClient>; file: string; timeoutMs?: number }) {
  const bounded = <T,>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routine read timed out')), timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  const history = createRoutineHistory({ file });
  let connection: RoutineRpcClient | null | undefined; let starting: Promise<void> | null | undefined; let taskStream: RpcStream | null | undefined; let shellStream: RpcStream | null | undefined; let tasks: RoutineTask[] = [];
  let healthy = false; let pending: Promise<unknown> = Promise.resolve(); const stamps = new Map<string, string | null | undefined>(); const threads = new Map<string, ShellThread>();
  const work = new Map<string, ShellThread>(); let workers = 0;
  const enqueue = (thread: ShellThread) => {
    if (!tasks.some((task) => task.projectId === thread.projectId) || stamps.get(thread.id) === thread.updatedAt) return;
    work.set(thread.id, thread);
    pump();
  };
  const pump = () => {
    while (connection && workers < 2 && work.size) { // Reads wait for the next connection, which re-queues every thread.
      const [key, thread] = work.entries().next().value!; work.delete(key); workers++;
      void bounded(connection.call('orchestration.getThreadProjection', { threadId: key })).then(async (projection) => {
        await history.consumeProjection(projection as RoutineProjection, new Set(tasks.map((task) => task.id))); stamps.set(key, thread.updatedAt);
      }).catch(() => { healthy = false; }).finally(() => { workers--; pump(); });
    }
  };
  const ready = async (): Promise<void> => {
    const client = await bounded(rpc());
    if (client === connection && taskStream && shellStream) return;
    if (starting) return starting;
    connection = client;
    starting = (async () => {
      cancel(taskStream); cancel(shellStream); stamps.clear(); threads.clear();
      let resolveTasks!: () => void; const first = new Promise<void>((resolve) => { resolveTasks = resolve; });
      taskStream = client.stream('scheduledTasks.subscribe', {}, (event: TaskEvent) => {
        if (!Array.isArray(event.tasks)) return;
        const snapshot = event.tasks;
        tasks = snapshot;
        pending = pending.catch(() => {}).then(() => history.consumeTasks(snapshot));
        pending.then(() => { healthy = true; resolveTasks(); }, () => { healthy = false; resolveTasks(); });
        for (const thread of threads.values()) enqueue(thread);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([first, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routine subscription timed out')), timeoutMs); })]); }
      catch (error) { cancel(taskStream); taskStream = null; throw error; }
      finally { clearTimeout(timer); }
      shellStream = client.stream('orchestration.subscribeShell', { omitIdleSubagents: true }, (event: ShellEvent) => {
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
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
