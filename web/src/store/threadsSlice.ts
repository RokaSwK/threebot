import { api } from "../lib/api";
import { queueOutboxMessage, flushOutbox } from "../lib/outbox";
import { revokeAssetHandles } from "../lib/assetCopies";
import { isDrawingJob } from "../lib/avatarDrawing";
import { botBadge, notificationContent, notificationTarget, waitingThread } from "../lib/notification";
import { enablePushNotifications, pushTurnedOff } from "../lib/push";
import { effectiveAlerts, routineOwner, routinePlace, routineTag } from "../lib/routineAlerts";
import { canStartSideChat, isSideChat, sideChatTitle } from "../lib/sideChats";
import {
  environmentHttp, environmentPrefix, environmentT3, t3, t3http, threadClient, threadKey,
  threadTarget, uuid, type StreamHandle, type ThreadTarget,
} from "../lib/t3";
import { forgetRecords, readView, ROOM_VIEW_BYTES, writeView } from "../lib/threadCache";
import { agentStatus, isProjectEnrichment } from "../lib/threadFamily";
import type { Bot, ProjectShell, Run, RuntimeRequest, ScheduledTask, Subagent, ThreadPreview, ThreadShell, TurnItem } from "../lib/types";
import { get, set, storeShared, useApp, type Attachment, type ThreadData } from "./context";
import { botReferenceKey, isSnoozed, previewForThread, refreshPreviews, schedulePreviews } from "./botsSlice";
import { linkedOnly } from "./authSlice";
import { select, toast } from "./uiSlice";

export { t3http, environmentT3, environmentHttp, threadClient, threadKey, threadTarget };

let shellSub: StreamHandle | null = null;
const mainThreadIds = (s: { bots: Record<string, Bot> }) => new Set(Object.values(s.bots).map((bot) => bot.mainThreadId));

export function subscribeShell() {
  shellSub?.cancel();
  shellSub = t3.stream("orchestration.subscribeShell", { omitIdleSubagents: true }, (it) => {
    if (it.kind === "snapshot") {
      const snap = it.snapshot;
      if (isProjectEnrichment(it)) {
        set((s) => ({ projects: { ...s.projects, ...Object.fromEntries(snap.projects.map((p: ProjectShell) => [p.id, p])) } }));
        return;
      }
      set((s) => ({
        projects: { ...s.projects, ...Object.fromEntries(snap.projects.map((p: ProjectShell) => [p.id, p])) },
        threads: { ...Object.fromEntries(Object.entries(s.threads).filter(([id]) => storeShared.familyThreadIds.has(id) || mainThreadIds(s).has(id))), ...s.archivedThreads, ...Object.fromEntries(snap.threads.map((t: ThreadShell) => [t.id, t])) },
      }));
      schedulePreviews();
      closeAnsweredNotifications();
    } else if (it.kind === "project.updated") {
      set((s) => ({ projects: { ...s.projects, [it.project.id]: it.project } }));
    } else if (it.kind === "project.removed") {
      set((s) => {
        const projects = { ...s.projects };
        delete projects[it.projectId];
        return { projects };
      });
    } else if (it.kind === "thread.updated") {
      if (it.location === "archive") {
        closeThreadNotices(it.thread.id);
        queueMicrotask(closeAnsweredNotifications);
        set((s) => ({ archivedThreads: { ...s.archivedThreads, [it.thread.id]: it.thread }, threads: { ...s.threads, [it.thread.id]: it.thread } }));
        return;
      }
      const prev = get().threads[it.thread.id];
      set((s) => { const archivedThreads = { ...s.archivedThreads }; delete archivedThreads[it.thread.id]; return { archivedThreads, threads: { ...s.threads, [it.thread.id]: it.thread } }; });
      schedulePreviews();
      notifyIfNeeded(prev, it.thread);
    } else if (it.kind === "thread.removed") {
      forgetThreadCopy([it.threadId]);
      closeThreadNotices(it.threadId);
      queueMicrotask(closeAnsweredNotifications);
      set((s) => {
        const threads = { ...s.threads };
        delete threads[it.threadId];
        storeShared.familyThreadIds.delete(it.threadId);
        const archivedThreads = { ...s.archivedThreads }; delete archivedThreads[it.threadId];
        return { threads, archivedThreads };
      });
    }
  });
}

// ---------- reactions and voice call log ----------
export async function loadThreadMeta(threadId: string) {
  if (threadTarget(threadId).environmentId) return;
  const meta = await api.threadMeta(threadId).catch(() => null);
  if (meta) set((s) => ({ threadMeta: { ...s.threadMeta, [threadId]: { ...meta, voiceCalls: (meta.voiceCalls ?? []).filter((call) => call.seconds >= 10) } } }));
}

export async function toggleReaction(threadId: string, itemId: string, emoji: string) {
  if (threadTarget(threadId).environmentId) throw new Error("Reactions are not available on this linked machine");
  const meta = await api.toggleReaction(threadId, itemId, emoji);
  set((s) => ({ threadMeta: { ...s.threadMeta, [threadId]: { ...meta, voiceCalls: (meta.voiceCalls ?? []).filter((call) => call.seconds >= 10) } } }));
}

export async function recordVoiceCall(threadId: string, seconds: number) {
  if (seconds < 10) return;
  if (threadTarget(threadId).environmentId) return;
  const meta = await api.addVoiceCall(threadId, seconds);
  set((s) => ({ threadMeta: { ...s.threadMeta, [threadId]: { ...meta, voiceCalls: (meta.voiceCalls ?? []).filter((call) => call.seconds >= 10) } } }));
}

// ---------- notifications ----------
export function watchedView(): { bot: string | null; room: string | null; thread: string | null } {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return { bot: null, room: null, thread: null };
  const state = get();
  if (state.page === "room" && state.selectedRoom) return { bot: null, room: state.selectedRoom, thread: null };
  if (state.page) return { bot: null, room: null, thread: null };
  return { bot: state.selected, room: null, thread: state.selectedThreadId };
}
function watchingThread(bot: Bot, threadId: string): boolean {
  const view = watchedView();
  return view.bot === bot.slug && (view.thread ?? bot.mainThreadId) === threadId;
}
const ACTIVE = ["preparing", "queued", "starting", "running", "waiting"];

function botByThread(thread: ThreadShell): Bot | null {
  const side = isSideChat(thread);
  const mainThreadId = side ? thread.lineage.parentThreadId : thread.id;
  return mainThreadId ? Object.values(get().bots).find((bot) => bot.mainThreadId === mainThreadId) ?? null : null;
}

function taskMode(task: ScheduledTask): string {
  return task.threadMode ?? (task.threadId === null ? "new_thread" : "continue");
}

function boundRoutine(threadId: string, bots: Bot[]): { task: ScheduledTask; bot: Bot } | null {
  const state = get();
  const candidates = state.tasks.filter((task) => task.threadId === threadId && taskMode(task) !== "new_thread");
  if (candidates.length !== 1) return null;
  const task = candidates[0];
  const owner = routineOwner(task, bots, state.routineAlerts);
  if (owner.kind !== "bot" || owner.bot.hidden) return null;
  return { task, bot: owner.bot };
}

function previewRoutine(preview: ThreadPreview | null | undefined, bots: Bot[], projectId: string | null | undefined): { task: ScheduledTask; bot: Bot } | null {
  if (!preview?.routine?.taskId) return null;
  const state = get();
  const task = state.tasks.find((entry) => entry.id === preview.routine!.taskId);
  if (!task || (task.projectId && projectId && task.projectId !== projectId)) return null;
  const owner = routineOwner(task, bots, state.routineAlerts);
  if (owner.kind !== "bot" || owner.bot.hidden) return null;
  return { task, bot: owner.bot };
}

function terminalInterested(thread: ThreadShell, failed: boolean): boolean {
  const state = get();
  const bots = Object.values(state.bots);
  const bound = boundRoutine(thread.id, bots);
  if (bound) {
    const place = routinePlace(bound.task, bound.bot);
    const alerts = effectiveAlerts(state.routineAlerts[bound.task.id], place);
    return failed ? alerts.failed : place === "chat" || alerts.finished;
  }
  const owner = botByThread(thread);
  const chatTasks = owner ? state.tasks.filter((task) => task.threadId === owner.mainThreadId) : [];
  if (chatTasks.some((task) => effectiveAlerts(state.routineAlerts[task.id], "chat")[failed ? "failed" : "finished"])) return true;
  if (!owner && state.tasks.some((task) => task.threadId === thread.id && taskMode(task) !== "new_thread"
    && effectiveAlerts(state.routineAlerts[task.id], "own")[failed ? "failed" : "finished"])) return true;
  if (owner) return !failed;
  return state.tasks.some((task) => task.projectId === thread.projectId && taskMode(task) === "new_thread"
    && effectiveAlerts(state.routineAlerts[task.id], "new")[failed ? "failed" : "finished"]);
}

function notifyIfNeeded(prev: ThreadShell | undefined, next: ThreadShell) {
  if (!prev) return;
  if (prev.pendingRuntimeRequest && !next.pendingRuntimeRequest) closeAnsweredNotifications();
  if (next.archivedAt || isSnoozed(next) || next.lineage.relationshipToParent === "subagent") return;
  if (!prev.pendingRuntimeRequest && next.pendingRuntimeRequest) {
    void waitingNotification(next).catch(() => {});
    return;
  }
  const side = isSideChat(next);
  const terminal = !side && ACTIVE.includes(prev.activityRunStatus ?? prev.status) && (next.status === "completed" || next.status === "failed");
  if (terminal && terminalInterested(next, next.status === "failed")) void completionNotification(next).catch(() => {});
}

async function waitingNotification(thread: ThreadShell) {
  const bots = Object.values(get().bots);
  const bound = boundRoutine(thread.id, bots);
  const boundPlace = bound ? routinePlace(bound.task, bound.bot) : null;
  const newThreadInterest = get().tasks.some((task) => task.projectId === thread.projectId && taskMode(task) === "new_thread"
    && get().routineAlerts[task.id]?.alerts?.waiting === true);
  const explicitWaiting = get().tasks.some((task) => task.threadId === thread.id && taskMode(task) !== "new_thread"
    && typeof get().routineAlerts[task.id]?.alerts?.waiting === "boolean");
  const preview = boundPlace === "chat" || newThreadInterest || explicitWaiting ? await previewForThread(thread) : undefined;
  const routine = previewRoutine(preview, bots, thread.projectId);
  if (routine) {
    if (routine.bot.notifications === false) return;
    const alerts = effectiveAlerts(get().routineAlerts[routine.task.id], routinePlace(routine.task, routine.bot));
    if (!alerts.waiting || watchingThread(routine.bot, thread.id)) return;
    return notifyRoutine(routine.bot, routine.task, "waiting", thread.id, "Needs attention");
  }
  const owner = botByThread(thread);
  if (!owner || owner.notifications === false || owner.hidden || watchingThread(owner, thread.id)) return;
  return notify(owner, isSideChat(thread) ? "A side chat is waiting for you" : "Waiting for you", "waiting", thread.id);
}

function closeAnsweredNotifications() {
  const waits = (thread?: ThreadShell) => !!thread?.pendingRuntimeRequest && !thread.archivedAt;
  void closeNotifications((tag, body) => {
    const { threads, bots } = get();
    const id = waitingThread(tag);
    if (id !== null) return !!threads[id] && !waits(threads[id]);
    const bot = Object.values(bots).find((b) => b.slug === tag);
    if (!bot || !LEGACY_WAITING.has(body)) return false;
    return !Object.values(threads).some((thread) => waits(thread) && (thread.id === bot.mainThreadId || (isSideChat(thread) && thread.lineage.parentThreadId === bot.mainThreadId)));
  });
}
const LEGACY_WAITING = new Set(["Waiting for you", "A side chat is waiting for you"]);

export async function completionNotification(completed: ThreadShell) {
  const isMain = Object.values(get().bots).some((bot) => bot.mainThreadId === completed.id);
  const preview = isMain ? (await refreshPreviews())[completed.id] : await previewForThread(completed);
  const bots = Object.values(get().bots);
  const routine = previewRoutine(preview, bots, completed.projectId);
  const failed = completed.status === "failed";
  const runStarted = completed.latestRunStartedAt ?? completed.latestRunRequestedAt ?? completed.latestUserMessageAt;
  const fresh = preview?.role === "assistant" && preview.at && (!runStarted || preview.at >= runStarted);
  const current = get().threads[completed.id];
  if (current && current.latestRunId !== completed.latestRunId) return;
  if (routine) {
    if (routine.bot.notifications === false) return;
    const alerts = effectiveAlerts(get().routineAlerts[routine.task.id], routinePlace(routine.task, routine.bot));
    if ((failed && !alerts.failed) || (!failed && !alerts.finished)) return;
    if (watchingThread(routine.bot, completed.id)) return;
    const body = failed ? "The run failed" : fresh ? preview.text.slice(0, 140) : "Finished";
    return notifyRoutine(routine.bot, routine.task, failed ? "failed" : "finished", completed.id, body);
  }
  const bot = botByThread(completed);
  if (!bot || failed || bot.notifications === false || bot.hidden || watchingThread(bot, completed.id)) return;
  return notify(bot, fresh ? preview.text.slice(0, 140) : "Finished", "finished", completed.id);
}

async function notify(bot: Bot, body: string, kind: "finished" | "waiting", threadId: string) {
  const target = notificationTarget(bot.slug, kind, threadId);
  return showNotice(bot, threadId, kind, bot.name, body, target, false);
}

async function notifyRoutine(bot: Bot, task: ScheduledTask, kind: "finished" | "waiting" | "failed", threadId: string, body: string) {
  const target = kind === "waiting" ? notificationTarget(bot.slug, "waiting", threadId) : { tag: routineTag(task.id), url: `/?bot=${encodeURIComponent(bot.slug)}&thread=${encodeURIComponent(threadId)}` };
  return showNotice(bot, threadId, kind, `${bot.name} · ${task.title}`, body, target, true);
}

async function showNotice(bot: Bot, threadId: string, kind: "finished" | "waiting" | "failed", title: string, body: string, target: { tag: string; url: string }, openThread: boolean) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const { title: shownTitle, options } = notificationContent({
    title, body, tag: target.tag, url: target.url,
    icon: `/api/bots/${encodeURIComponent(bot.slug)}/avatar.png`,
    badge: botBadge(bot),
    timestamp: Date.now(),
  });
  const stale = () => {
    const thread = get().threads[threadId];
    return kind === "waiting" && (!thread?.pendingRuntimeRequest || !!thread.archivedAt);
  };
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.showNotification(shownTitle, options);
    if (stale()) void closeNotifications((tag) => tag === target.tag);
    return;
  }
  const notification = new Notification(shownTitle, options);
  pageNotices.get(target.tag)?.close();
  pageNotices.set(target.tag, notification);
  notification.onclose = () => { if (pageNotices.get(target.tag) === notification) pageNotices.delete(target.tag); };
  notification.onclick = () => {
    window.focus();
    if (openThread && threadId !== bot.mainThreadId) selectThread(bot, threadId);
    else select(bot.slug);
    notification.close();
  };
  if (stale()) notification.close();
}

const pageNotices = new Map<string, Notification>();
async function closeNotifications(match: (tag: string, body: string) => boolean) {
  try {
    const registration = typeof navigator === "undefined" ? undefined : await navigator.serviceWorker?.getRegistration();
    for (const [tag, notification] of pageNotices) if (match(tag, notification.body)) notification.close();
    if (!registration?.getNotifications) return;
    for (const notification of await registration.getNotifications()) if (match(notification.tag, notification.body)) notification.close();
  } catch { /* A closed or unsupported notification is not an error worth showing. */ }
}

const closeThreadNotices = (threadId: string) => void closeNotifications((tag) => waitingThread(tag) === threadId);

export function requestNotificationPermission() {
  if (pushTurnedOff()) return;
  void enablePushNotifications();
}

// ---------- thread subscriptions & local copy ----------
const threadSubs = new Map<string, { handle: StreamHandle; refs: number; bounded: boolean }>();
const environmentReconnects = new Set<string>();
const threadSequences = new Map<string, number>();
const completeThreads = new Set<string>();
const snapshotGenerations = new Map<string, number>();
const streamGenerations = new Map<string, number>();

function emptyThread(): ThreadData {
  return { items: {}, runs: {}, requests: {}, subagents: {}, loaded: false };
}

function patchThread(threadId: string, fn: (d: ThreadData) => ThreadData) {
  set((s) => ({ threadData: { ...s.threadData, [threadId]: fn(s.threadData[threadId] ?? emptyThread()) } }));
  scheduleCache(threadId);
}

function scopedShell(thread: ThreadShell, environmentId?: string): ThreadShell {
  if (!environmentId) return thread;
  const key = (id: string) => threadKey({ threadId: id, environmentId });
  return { ...thread, id: key(thread.id), environmentId, lineage: { ...thread.lineage, parentThreadId: thread.lineage.parentThreadId ? key(thread.lineage.parentThreadId) : null, rootThreadId: key(thread.lineage.rootThreadId) } };
}

function openThreadStream(threadId: string, bounded = true): StreamHandle {
  const target = threadTarget(threadId);
  const stream = (streamGenerations.get(threadId) ?? 0) + 1;
  streamGenerations.set(threadId, stream);
  if (bounded) storeShared.roomThreads.delete(threadId); else storeShared.roomThreads.add(threadId);
  if (target.environmentId) storeShared.familyThreadIds.add(threadId);
  const afterSequence = bounded || completeThreads.has(threadId) ? threadSequences.get(threadId) : undefined;
  const handle = threadClient(threadId).stream("orchestration.subscribeThread", { threadId: target.threadId, ...(bounded ? { acceptBoundedSnapshot: true, acceptCompactTurnItems: true } : {}), ...(afterSequence !== undefined ? { afterSequence } : {}), ...(!target.environmentId && get().runtimeFeatures.threadResumeCompletionMarker ? { requestCompletionMarker: true } : {}) }, (it) => {
    if (streamGenerations.get(threadId) !== stream) return;
    if (it.kind === "snapshot") {
      const p = it.projection;
      if (p.thread) p.thread = scopedShell(p.thread, target.environmentId);
      if (p.thread) set((s) => ({ threads: { ...s.threads, [p.thread.id]: { ...s.threads[p.thread.id], ...p.thread } } }));
      const items: Record<string, TurnItem> = {};
      for (const v of p.visibleTurnItems ?? []) items[v.item.id] = v.item;
      if (!p.visibleTurnItems?.length) for (const i of p.turnItems ?? []) items[i.id] = i;
      else for (const i of p.turnItems ?? []) if (i.type === "run_interrupt_request" && !items[i.id]) items[i.id] = i;
      patchThread(threadId, () => ({
        items,
        runs: Object.fromEntries((p.runs ?? []).map((r: Run) => [r.id, r])),
        requests: Object.fromEntries((p.runtimeRequests ?? []).map((r: RuntimeRequest) => [r.id, r])),
        subagents: Object.fromEntries((p.subagents ?? []).map((agent: Subagent) => [agent.id, agent])),
        loaded: true,
        stale: false,
        historyCursor: it.hasMoreHistory ? it.historyCursor ?? null : null,
        hasMoreHistory: it.hasMoreHistory === true && typeof it.historyCursor === "string",
      }));
      if (typeof it.snapshotSequence === "number") threadSequences.set(threadId, it.snapshotSequence);
      snapshotGenerations.set(threadId, (snapshotGenerations.get(threadId) ?? 0) + 1);
      if (it.hasMoreHistory === true) completeThreads.delete(threadId); else completeThreads.add(threadId);
      if (p.subagents?.length) void loadThreadFamily(threadId);
    } else if (it.kind === "synchronized") {
      patchThread(threadId, (d) => ({ ...d, loaded: true }));
    } else if (it.kind === "event") {
      if (typeof it.sequence === "number" && it.sequence > (threadSequences.get(threadId) ?? -1)) threadSequences.set(threadId, it.sequence);
      const ev = it.event;
      if (ev.type === "turn-item.updated") patchThread(threadId, (d) => ({ ...d, items: { ...d.items, [ev.payload.id]: ev.payload } }));
      else if (ev.type === "run.created" || ev.type === "run.updated") patchThread(threadId, (d) => ({ ...d, runs: { ...d.runs, [ev.payload.id]: ev.payload } }));
      else if (ev.type === "runtime-request.updated") patchThread(threadId, (d) => ({ ...d, requests: { ...d.requests, [ev.payload.id]: ev.payload } }));
      else if (ev.type === "subagent.updated") {
        patchThread(threadId, (d) => ({ ...d, subagents: { ...d.subagents, [ev.payload.id]: { ...d.subagents?.[ev.payload.id], ...ev.payload } } }));
        if (ev.payload.childThreadId) void loadThreadFamily(threadId);
      } else if (["thread.settled", "thread.unsettled", "thread.snoozed", "thread.unsnoozed"].includes(ev.type)) {
        set((s) => ({ threads: { ...s.threads, [threadId]: { ...s.threads[threadId], ...ev.payload, id: threadId } } }));
      }
    }
  });
  void hydrateThread(threadId, stream);
  return handle;
}

export function forgetThreadCopy(threadIds: string[]) {
  for (const threadId of threadIds) {
    storeShared.forgottenThreads.add(threadId);
    clearTimeout(storeShared.cacheTimers.get(threadId));
    storeShared.cacheTimers.delete(threadId);
  }
  void forgetRecords(threadIds.map((threadId) => `view:${threadId}`), { deleted: true }).then(revokeAssetHandles);
  set((s) => {
    const threadData = { ...s.threadData };
    for (const threadId of threadIds) if (threadData[threadId]?.stale) delete threadData[threadId];
    return { threadData };
  });
}

function scheduleCache(threadId: string) {
  if (storeShared.forgetting || storeShared.cacheTimers.has(threadId) || storeShared.forgottenThreads.has(threadId)) return;
  storeShared.cacheTimers.set(threadId, setTimeout(() => { storeShared.cacheTimers.delete(threadId); void saveThread(threadId); }, 1200));
}

async function saveThread(threadId: string) {
  if (storeShared.forgetting || storeShared.forgottenThreads.has(threadId)) return;
  if (threadTarget(threadId).environmentId) return;
  const data = get().threadData[threadId];
  if (!data?.loaded || data.stale) return;
  await writeView({
    v: 1, key: threadId, savedAt: Date.now(), thread: get().threads[threadId] ?? null,
    items: Object.values(data.items ?? {}), runs: Object.values(data.runs ?? {}),
    requests: Object.values(data.requests ?? {}), subagents: Object.values(data.subagents ?? {}),
    historyCursor: data.historyCursor ?? null, hasMoreHistory: data.hasMoreHistory === true,
  }, storeShared.roomThreads.has(threadId) ? ROOM_VIEW_BYTES : undefined, storeShared.roomOfThread.has(threadId) ? `room:${storeShared.roomOfThread.get(threadId)}` : undefined);
}

export function flushCache() {
  if (storeShared.forgetting) return;
  for (const [threadId, timer] of storeShared.cacheTimers) {
    clearTimeout(timer);
    storeShared.cacheTimers.delete(threadId);
    void saveThread(threadId);
  }
}

async function hydrateThread(threadId: string, generation: number) {
  if (get().threadData[threadId]?.loaded) return;
  const view = await readView(threadId);
  if (!view) {
    if (streamGenerations.get(threadId) === generation) patchThread(threadId, (data) => data.loaded ? data : { ...data, copyChecked: true });
    return;
  }
  if (get().threadData[threadId]?.loaded || streamGenerations.get(threadId) !== generation || storeShared.forgottenThreads.has(threadId)) return;
  if (view.thread && !get().threads[view.thread.id]) set((s) => ({ threads: { ...s.threads, [view.thread!.id]: view.thread! } }));
  patchThread(threadId, (data) => data.loaded ? data : {
    items: Object.fromEntries(view.items.flatMap((item) => item && typeof item.id === "string" ? [[item.id, item] as const] : [])),
    runs: Object.fromEntries(view.runs.flatMap((run) => run && typeof run.id === "string" ? [[run.id, run] as const] : [])),
    requests: Object.fromEntries(view.requests.flatMap((request) => request && typeof request.id === "string" ? [[request.id, request] as const] : [])),
    subagents: Object.fromEntries(view.subagents.flatMap((agent) => agent && typeof agent.id === "string" ? [[agent.id, agent] as const] : [])),
    loaded: true, stale: true, copyChecked: true, historyCursor: view.historyCursor, hasMoreHistory: view.hasMoreHistory,
  });
}

const olderLoads = new Set<string>();
export async function loadOlderMessages(threadId: string): Promise<boolean> {
  const data = get().threadData[threadId];
  if (!data?.hasMoreHistory || !data.historyCursor || data.stale || olderLoads.has(threadId)) return false;
  olderLoads.add(threadId);
  const generation = snapshotGenerations.get(threadId);
  try {
    const target = threadTarget(threadId);
    const page = await environmentHttp<{ items?: { item: TurnItem }[]; nextCursor?: string | null; hasMoreHistory?: boolean }>(target.environmentId, `/api/orchestration/threads/${encodeURIComponent(target.threadId)}/history?cursor=${encodeURIComponent(data.historyCursor)}`);
    if (snapshotGenerations.get(threadId) !== generation) return false;
    const older = Object.fromEntries((page.items ?? []).flatMap((row) => {
      const item = row?.item;
      return item && typeof item.id === "string" ? [[item.id, item]] : [];
    }));
    if (page.hasMoreHistory !== true) completeThreads.add(threadId);
    patchThread(threadId, (d) => ({ ...d, items: { ...older, ...d.items }, historyCursor: page.nextCursor ?? null, hasMoreHistory: page.hasMoreHistory === true && typeof page.nextCursor === "string" }));
    return Object.keys(older).length > 0;
  } catch (error) {
    toast(error instanceof Error ? error.message : "Couldn't load earlier messages");
    return false;
  } finally {
    olderLoads.delete(threadId);
  }
}

export function watchThread(threadId: string, bounded = true) {
  const existing = threadSubs.get(threadId);
  if (existing) {
    existing.refs++;
    if (existing.bounded && !bounded) {
      existing.handle.cancel();
      existing.bounded = false;
      existing.handle = subscribedThread(threadId, false);
    }
  } else {
    const environmentId = threadTarget(threadId).environmentId;
    if (environmentId && !environmentReconnects.has(environmentId)) {
      environmentReconnects.add(environmentId);
      threadClient(threadId).onReconnect(() => {
        for (const [key, sub] of threadSubs) if (threadTarget(key).environmentId === environmentId && !sub.handle.live()) {
          sub.handle.cancel(); sub.handle = subscribedThread(key, sub.bounded);
        }
      });
    }
    threadSubs.set(threadId, { handle: subscribedThread(threadId, bounded), refs: 1, bounded });
  }
  return () => {
    const sub = threadSubs.get(threadId);
    if (!sub) return;
    if (--sub.refs <= 0) {
      sub.handle.cancel();
      threadSubs.delete(threadId);
    }
  };
}

function subscribedThread(threadId: string, bounded: boolean) {
  const handle = openThreadStream(threadId, bounded);
  void handle.done.catch((error: unknown) => {
    patchThread(threadId, (data) => ({ ...data, loaded: true }));
    toast(error instanceof Error ? error.message : "Couldn't read this conversation");
  });
  return handle;
}

export function resubscribeThreads() {
  for (const [threadId, sub] of threadSubs) {
    if (threadTarget(threadId).environmentId || sub.handle.live()) continue;
    sub.handle.cancel();
    sub.handle = subscribedThread(threadId, sub.bounded);
  }
}

export function conversationStatus(threadId: string, s = get()) {
  const thread = s.threads[threadId];
  const parent = thread?.lineage.parentThreadId;
  const data = parent ? s.threadData[parent] : undefined;
  const agent = [...Object.values(data?.items ?? {}), ...Object.values(data?.subagents ?? {})]
    .filter((item) => item.childThreadId === threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return agentStatus({ thread, fallback: agent?.status, updatedAt: agent?.updatedAt });
}

export function botThreadStatus(bot: Pick<Bot, "mainThreadId">, threadId: string, s = get()) {
  const status = conversationStatus(threadId, s);
  return status === "completed" && threadId === bot.mainThreadId && s.settings?.beta?.settleBotThreads === true ? "idle" : status;
}

export function selectThread(bot: Bot, threadId: string, fromSearch = false) {
  set({ selected: botReferenceKey(bot), selectedThreadId: threadId === bot.mainThreadId ? null : threadId, exchangeBotSlug: null, page: null, projectItemId: null, ...(fromSearch ? { dialog: null, searchResultRevision: get().searchResultRevision + 1 } : {}) });
  if (linkedOnly(threadId)) return;
  threadClient(threadId).dispatch({ type: "thread.visit", threadId: threadTarget(threadId).threadId, visitedAt: new Date().toISOString() }).catch(() => {});
  loadThreadFamily(threadId);
}

export async function markThreadRead(threadId: string) {
  await threadClient(threadId).dispatch({ type: "thread.visit", threadId: threadTarget(threadId).threadId, visitedAt: new Date().toISOString() });
  await reconcileThread(threadId);
}

export async function markThreadUnread(threadId: string) {
  await threadClient(threadId).dispatch({ type: "thread.mark-unread", threadId: threadTarget(threadId).threadId });
}

const familyLoads = new Map<string, Promise<void>>();
export function loadThreadFamily(threadId: string): Promise<void> {
  const pending = familyLoads.get(threadId);
  if (pending) return pending;
  const target = threadTarget(threadId);
  const request = threadClient(threadId).call<{ threads: ThreadShell[] }>("orchestration.getThreadFamily", { threadId: target.threadId }).then((family) => {
    family.threads = family.threads.map((thread) => scopedShell(thread, target.environmentId));
    for (const thread of family.threads) if (target.environmentId || thread.lineage.relationshipToParent === "subagent") storeShared.familyThreadIds.add(thread.id);
    set((s) => ({ threads: { ...s.threads, ...Object.fromEntries(family.threads.map((thread) => [thread.id, s.threads[thread.id]?.updatedAt > thread.updatedAt ? s.threads[thread.id] : thread])) } }));
  }).catch(() => {}).finally(() => { familyLoads.delete(threadId); });
  familyLoads.set(threadId, request);
  return request;
}

export async function uploadAttachment(file: File, environmentId?: string): Promise<Attachment> {
  const type = file.type.startsWith("image/") ? "image" : "file";
  const { attachmentId, relativeUrl } = await environmentT3(environmentId).call("attachments.createUploadUrl", { type, name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size });
  const res = await fetch(`${environmentPrefix(environmentId)}${relativeUrl}`, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return { type, id: attachmentId, ...(environmentId ? { environmentId } : {}), name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, previewUrl: type === "image" ? URL.createObjectURL(file) : undefined };
}

export async function sendMessage(slug: string, text: string, attachments: Attachment[] = [], threadId = get().bots[slug]?.mainThreadId, messageId = uuid(), fresh = false) {
  if (!threadId) throw new Error("This Bot has no conversation yet");
  if (attachments.some((attachment) => attachment.environmentId !== threadTarget(threadId).environmentId)) throw new Error("Upload attachments to the conversation’s machine before sending");
  if ((typeof navigator !== "undefined" && navigator.onLine === false) || get().offline) {
    queueOutboxMessage({ id: messageId, threadId, text, attachments, fresh });
    toast("Offline — message queued and will send when connected");
    return;
  }
  await dispatchMessage(threadId, text, attachments, messageId, fresh);
}

async function dispatchMessage(threadId: string, text: string, attachments: Attachment[], messageId: string, fresh: boolean) {
  const effort = get().threads[threadId]?.modelSelection?.options?.find((o) => o.id === "effort")?.value;
  const body = effort === "ultrathink" && text && !/^ultrathink:/i.test(text) ? `Ultrathink: ${text}` : text;
  await threadClient(threadId).dispatch({
    commandId: messageId, type: "message.dispatch", threadId: threadTarget(threadId).threadId, messageId,
    text: body, attachments: attachments.map(({ previewUrl: _p, environmentId: _environment, ...a }) => a),
    createdBy: "user", creationSource: "web", deliveryIntent: "steer", dispatchMode: { type: "start_immediately" },
    ...(fresh ? { freshContext: true } : {}),
  }, { timeoutMs: 30_000 });
}

export async function flushPendingOutbox() {
  if (get().connection !== "open" || get().offline || navigator.onLine === false) return 0;
  return flushOutbox((entry) => dispatchMessage(entry.threadId, entry.text, entry.attachments, entry.id, entry.fresh));
}

export async function interrupt(threadId: string) {
  const t = get().threads[threadId];
  const runId = t?.activeRunId ?? t?.latestRunId;
  if (runId) await threadClient(threadId).dispatch({ type: "run.interrupt", threadId: threadTarget(threadId).threadId, runId });
}

export function canStartFresh(threadId: string | null, state = get()) {
  return !!threadId && state.runtimeFeatures.freshContext && !threadTarget(threadId).environmentId;
}

export async function forceStopThread(threadId: string, runId: string) {
  const result = await threadClient(threadId).call<{ outcome?: string; sharedWithThreadIds?: string[] }>("orchestration.forceStopThread", { threadId: threadTarget(threadId).threadId, runId });
  if (result?.outcome === "releasing") toast("Stopped. The agent is still shutting down.");
  else if (result?.outcome === "shared") toast("Stopped. The agent process kept running because other threads share it.");
}

function liveOnly(threadId: string) {
  if (get().threadData[threadId]?.stale) throw new Error("This is a saved copy. Try again once the conversation has loaded.");
}

export async function respondRequest(threadId: string, requestId: string, decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel") {
  liveOnly(threadId);
  await threadClient(threadId).dispatch({ type: "runtime-request.respond", threadId: threadTarget(threadId).threadId, requestId, decision });
}

export async function answerQuestion(threadId: string, requestId: string, answers: Record<string, unknown>) {
  liveOnly(threadId);
  await threadClient(threadId).dispatch({ type: "runtime-request.respond", threadId: threadTarget(threadId).threadId, requestId, answers });
}

export async function dismissQuestion(threadId: string, requestId: string) {
  liveOnly(threadId);
  await threadClient(threadId).dispatch({ type: "thread.user-input.dismiss", threadId: threadTarget(threadId).threadId, requestId });
}

export async function answerSecret(threadId: string, turnItemId: string, secret: string | null) {
  liveOnly(threadId);
  await threadClient(threadId).call("secrets.answerRequest", { threadId: threadTarget(threadId).threadId, turnItemId, answer: secret === null ? { type: "decline" } : { type: "save", secret } });
}

export async function assetUrl(resource: Record<string, unknown>, environmentId?: string) {
  const target = typeof resource.threadId === "string" ? threadTarget(resource.threadId) : null;
  if (environmentId && target?.environmentId && environmentId !== target.environmentId) throw new Error("The file belongs to a different machine");
  const scope = environmentId ?? target?.environmentId;
  const { relativeUrl } = await environmentT3(scope).call("assets.createUrl", { resource: target ? { ...resource, threadId: target.threadId } : resource });
  return `${environmentPrefix(scope)}${relativeUrl}`;
}

export async function listFiles(cwd: string, directoryPath?: string, environmentId?: string): Promise<{ entries: { path: string; kind: string }[]; truncated: boolean } | null> {
  return environmentT3(environmentId).call("projects.listEntries", directoryPath ? { cwd, directoryPath } : { cwd }).catch(() => null);
}

export async function readFile(cwd: string, relativePath: string, environmentId?: string): Promise<string | null> {
  const r = await environmentT3(environmentId).call("projects.readFile", { cwd, relativePath, allowMissing: true }).catch(() => null);
  return r?.contents ?? null;
}

export function selectEnvironmentThread(bot: Bot, target: ThreadTarget) { selectThread(bot, threadKey(target)); }
export async function setThreadDone(threadId: string, done: boolean) {
  await threadClient(threadId).dispatch({ type: done ? "thread.settle" : "thread.unsettle", threadId: threadTarget(threadId).threadId, ...(!done ? { reason: "user" } : {}) });
  await reconcileThread(threadId);
}
export async function setThreadAutoSettle(threadId: string, enabled: boolean) {
  await threadClient(threadId).dispatch({ type: "thread.auto-settle.set", threadId: threadTarget(threadId).threadId, enabled });
  await reconcileThread(threadId);
}
export async function snoozeThread(threadId: string, snoozedUntil: string | null) {
  if (snoozedUntil && (!Number.isFinite(Date.parse(snoozedUntil)) || Date.parse(snoozedUntil) <= Date.now())) throw new Error("Choose a future snooze time");
  await threadClient(threadId).dispatch({ type: snoozedUntil ? "thread.snooze" : "thread.unsnooze", threadId: threadTarget(threadId).threadId, ...(snoozedUntil ? { snoozedUntil } : { reason: "user" }) });
  await reconcileThread(threadId);
}
async function reconcileThread(key: string) {
  const target = threadTarget(key);
  const projection = await threadClient(key).call<{ thread: ThreadShell }>("orchestration.getThreadProjection", { threadId: target.threadId });
  const thread = scopedShell(projection.thread, target.environmentId);
  set((s) => { const archivedThreads = { ...s.archivedThreads }; if (thread.archivedAt) archivedThreads[key] = thread; else delete archivedThreads[key]; return { archivedThreads, threads: { ...s.threads, [key]: thread } }; });
}
export async function archiveThread(threadId: string, archived: boolean) {
  await threadClient(threadId).dispatch({ type: archived ? "thread.archive" : "thread.unarchive", threadId: threadTarget(threadId).threadId });
  await reconcileThread(threadId);
}
export async function loadArchivedThreads() {
  try {
    const snapshot = await t3.call<{ threads: ThreadShell[]; projects: ProjectShell[] }>("orchestration.getArchivedShellSnapshot", {});
    const archivedThreads = Object.fromEntries(snapshot.threads.filter((t) => !isDrawingJob(t)).map((t) => [t.id, t]));
    set((s) => ({ archiveError: null, archivedThreads: { ...Object.fromEntries(Object.entries(s.archivedThreads).filter(([id]) => !!threadTarget(id).environmentId)), ...archivedThreads }, threads: { ...Object.fromEntries(Object.entries(s.threads).filter(([id,t]) => !!threadTarget(id).environmentId || !t.archivedAt)), ...archivedThreads }, projects: { ...s.projects, ...Object.fromEntries(snapshot.projects.map((p) => [p.id, p])) } }));
  } catch (error) { set({ archiveError: error instanceof Error ? error.message : "Couldn't load archived conversations" }); }
}
export async function loadOlderDone() {
  if (!get().runtimeFeatures.shellOlderSettled) throw new Error("This T3 server does not support older done conversations");
  const page = await t3.call<{ threads: ThreadShell[] }>("orchestration.getOlderSettledThreads", { before: get().olderSettledCursor ?? { settledAt: new Date().toISOString() }, limit: 30 });
  for (const t of page.threads) storeShared.familyThreadIds.add(t.id);
  const last = page.threads.at(-1);
  set((s) => ({ threads: { ...s.threads, ...Object.fromEntries(page.threads.map((t) => [t.id, t])) }, olderSettledCursor: last?.settledAt ? { settledAt: last.settledAt, threadId: last.id } : s.olderSettledCursor }));
  return page.threads.length;
}
export function threadArrives(threadId: string, timeoutMs = 10_000) {
  if (get().threads[threadId]) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (arrived: boolean) => { clearTimeout(timer); stop(); resolve(arrived); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const stop = useApp.subscribe((state) => { if (state.threads[threadId]) finish(true); });
  });
}

let sideChatStarting = false;
export async function startSideChat(bot: Bot, parentThreadId: string, prompt = "") {
  if (sideChatStarting) return false;
  if (!get().runtimeFeatures.sideChats || !canStartSideChat(get().threads[parentThreadId])) {
    toast("Side chats aren't available in this conversation");
    return false;
  }
  sideChatStarting = true;
  const threadId = uuid();
  const discard = () => void t3.dispatch({ type: "thread.delete", threadId, onlyIfUnused: true }).catch(() => {});
  try {
    await t3.dispatch({ type: "thread.fork", createdBy: "user", creationSource: "web", sourceThreadId: parentThreadId, targetThreadId: threadId, sourcePoint: { type: "latest_stable" }, sideChat: true, title: sideChatTitle(prompt) }, { timeoutMs: 30_000 });
    if (!await threadArrives(threadId)) throw new Error("The side chat didn't reach this device. Try again.");
    if (prompt) await sendMessage(bot.slug, prompt, [], threadId);
    set({ sideChat: { parentThreadId, threadId } });
    return true;
  } catch (error) {
    discard();
    toast(error instanceof Error ? error.message : "Couldn't start a side chat");
    return false;
  } finally {
    sideChatStarting = false;
  }
}

export function openSideChat(parentThreadId: string, threadId: string) {
  set({ sideChat: { parentThreadId, threadId } });
  void markThreadRead(threadId).catch(() => {});
}

export function closeSideChat() {
  const open = get().sideChat;
  if (!open) return;
  set({ sideChat: null });
  if (!get().threads[open.threadId]) return;
  void markThreadRead(open.threadId).catch(() => {});
  void t3.dispatch({ type: "thread.delete", threadId: open.threadId, onlyIfUnused: true }).catch(() => {});
}

export async function bringBackSideChat(threadId: string, parentThreadId: string, runId: string) {
  await t3.dispatch({ type: "thread.merge_back", createdBy: "user", creationSource: "web", sourceThreadId: threadId, targetThreadId: parentThreadId, sourcePoint: { type: "run", runId } });
}

export async function deleteSideChat(threadId: string) {
  await t3.dispatch({ type: "thread.delete", threadId });
  forgetThreadCopy([threadId]);
  if (get().sideChat?.threadId === threadId) set({ sideChat: null });
}

export async function navigateSearchHit(bot: Bot, hit: { threadId: string; messageId?: string; query: string }) {
  selectThread(bot, hit.threadId, true);
  const projection = await threadClient(hit.threadId).call<{ turnItems: TurnItem[]; visibleTurnItems?: { item: TurnItem }[] }>("orchestration.getThreadProjection", { threadId: threadTarget(hit.threadId).threadId });
  const current = () => get().selected === botReferenceKey(bot) && (get().selectedThreadId ?? bot.mainThreadId) === hit.threadId && get().dialog !== "search";
  if (!current()) return;
  const items = projection.visibleTurnItems?.map((row) => row.item) ?? projection.turnItems;
  let entryId = hit.messageId ? items.find((item) => item.id === hit.messageId || item.messageId === hit.messageId)?.id : undefined;
  if (!entryId && get().runtimeFeatures.threadFind) {
    const result = await threadClient(hit.threadId).call<{ match: { entryId: string } | null }>("orchestration.searchThread", { threadId: threadTarget(hit.threadId).threadId, query: hit.query });
    entryId = result.match?.entryId;
  }
  if (!entryId) { toast("Opened the conversation; this server did not identify the matching entry"); return; }
  const id = entryId;
  for (let wait = 0; wait < 100 && !get().threadData[hit.threadId]?.loaded; wait++) await new Promise((resolve) => setTimeout(resolve, 100));
  for (let page = 0; page < 50 && current() && !get().threadData[hit.threadId]?.items[id] && get().threadData[hit.threadId]?.hasMoreHistory; page++) {
    if (!(await loadOlderMessages(hit.threadId))) break;
  }
  const observer = new MutationObserver(reveal);
  const timer = setTimeout(() => { observer.disconnect(); toast("Opened the conversation; the matching entry could not be displayed"); }, 10000);
  function reveal() {
    if (!current()) { observer.disconnect(); clearTimeout(timer); return; }
    const entries = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-entry]"));
    const element = entries.find((entry) => entry.dataset.chatEntry === id);
    if (element) {
      element.closest(".chat-scroller")?.dispatchEvent(new Event("chat-search-reveal"));
      const bubble = element.querySelector<HTMLElement>(".bubble");
      const target = bubble ?? (element.firstElementChild instanceof HTMLElement ? element.firstElementChild : element);
      target.scrollIntoView({ block: "center" });
      target.animate([{ backgroundColor: "var(--bg-active)" }, { backgroundColor: getComputedStyle(target).backgroundColor }], { duration: 1800 });
      observer.disconnect(); clearTimeout(timer);
    } else {
      const earlier = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-messages button")).find((button) => button.textContent === "Load earlier messages");
      earlier?.click();
    }
  }
  observer.observe(document.body, { childList: true, subtree: true });
  reveal();
}
