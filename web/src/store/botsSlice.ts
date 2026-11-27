import { isCustomColor } from "../../../shared/avatar-color.mts";
import { api } from "../lib/api";
import { DRAWING_OPTIONS, drawingModel, drawingPrompt, drawingResult, drawingTitle, fixPrompt, type DrawingOption } from "../lib/avatarDrawing";
import { rememberColor } from "../lib/recentColors";
import { loadRoutineAlerts, loadRoutineRuns, saveRoutineAlerts, type RoutineRecord, type RoutineRunRef } from "../lib/routineAlerts";
import { t3, threadClient, threadTarget, uuid, type StreamHandle } from "../lib/t3";
import type { Bot, ModelSelection, ProjectShell, Run, Settings, ThreadPreview, ThreadShell, TurnItem } from "../lib/types";
import { deadline, GATEWAY_PATIENCE_MS, get, keepBoot, PREVIEWS_KEY, set, storeShared, useApp, type BotStatus, type State } from "./context";
import { signedOut } from "./authSlice";
import { forgetThreadCopy, interrupt, sendMessage, threadArrives } from "./threadsSlice";
import { select } from "./uiSlice";

// ---------- routine alerts & runs ----------
/** Per-routine records from the gateway. A failure leaves the cached copy and the legacy rules in place. */
export async function refreshRoutineAlerts(): Promise<void> {
  const routineAlerts = await loadRoutineAlerts().catch(() => null);
  if (routineAlerts) set({ routineAlerts });
}

/** Writes one routine's record and keeps the store in step with what the gateway stored. */
export async function updateRoutineAlerts(taskId: string, patch: { bot?: string | null; alerts?: Partial<Record<"finished" | "failed" | "waiting", boolean>> }): Promise<RoutineRecord> {
  const task = await saveRoutineAlerts(taskId, patch);
  set((s) => ({ routineAlerts: { ...s.routineAlerts, [taskId]: task } }));
  return task;
}

const routineRunReads = new Map<string, Promise<void>>();
/** Newest observed run per routine, from the gateway's persisted refs; no T3 projection is opened. */
export async function refreshRoutineRuns(taskIds: string[]): Promise<void> {
  const ids = [...new Set(taskIds)].filter((id) => /^[\w:%.-]{1,600}$/.test(id)).sort();
  if (!ids.length) return;
  const state = get();
  const generation = ids.map((id) => `${id}:${state.tasks.find((task) => task.id === id)?.lastRunAt ?? ""}`).join("|");
  const key = `${generation}|${ids.join("|")}`;
  const pending = routineRunReads.get(key);
  if (pending) return pending;
  let read!: Promise<void>;
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 20) chunks.push(ids.slice(index, index + 20));
  read = Promise.all(chunks.map((chunk) => loadRoutineRuns(chunk)))
    .then((results) => set((current) => {
      const routineRuns = { ...current.routineRuns };
      const routineRunsStale = { ...current.routineRunsStale };
      const returned = Object.assign({}, ...results) as Record<string, RoutineRunRef>;
      for (const id of ids) {
        const run = returned[id];
        const lastRunAt = current.tasks.find((task) => task.id === id)?.lastRunAt;
        const since = lastRunAt ? Date.parse(lastRunAt) - 5_000 : null;
        if (run && (since === null || Date.parse(run.at) >= since)) {
          if (!routineRuns[id] || run.at >= routineRuns[id].at) routineRuns[id] = run;
          delete routineRunsStale[id];
        } else if (routineRuns[id]) {
          routineRunsStale[id] = true;
        }
      }
      return { routineRuns, routineRunsStale };
    }))
    .catch(() => {
      set((current) => {
        const routineRunsStale = { ...current.routineRunsStale };
        for (const id of ids) routineRunsStale[id] = true;
        return { routineRunsStale };
      });
    })
    .finally(() => { if (routineRunReads.get(key) === read) routineRunReads.delete(key); });
  routineRunReads.set(key, read);
  return read;
}

export async function refreshBots() {
  const revision = storeShared.botsRevision;
  const [bots, historical] = await Promise.all([api.bots(deadline(GATEWAY_PATIENCE_MS)).catch(() => null), api.botIdentities(deadline(GATEWAY_PATIENCE_MS)).catch(() => null)]);
  if (!bots) {
    const session = await api.session().catch(() => null);
    if (session && !session.authenticated) signedOut(session);
    return;
  }
  if (revision !== storeShared.botsRevision || storeShared.pendingBotMutations) return;
  set({ bots: Object.fromEntries(bots.map((b) => [b.slug, b])) });
  if (historical) set({ historicalBots: Object.fromEntries(historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
  keepBoot({ botsRoot: get().botsRoot, executorUrl: get().executorUrl, settings: get().settings, bots, historical: historical ?? Object.values(get().historicalBots) });
}

// ---------- roster previews & tasks ----------
let previewTimer: ReturnType<typeof setTimeout> | undefined;
export function schedulePreviews() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreviews(), 400);
}

export async function refreshPreviews() {
  const { bots, threads } = get();
  const stamps = Object.fromEntries(Object.values(bots).flatMap((bot) => {
    const thread = bot.mainThreadId ? threads[bot.mainThreadId] : undefined;
    return thread ? [[thread.id, thread.updatedAt]] : [];
  }));
  if (!Object.keys(stamps).length) return {};
  const previews = await api.threadPreviews(stamps).catch(() => null);
  if (!previews) return {};
  const current = Object.fromEntries(Object.entries(previews).filter(([id]) => get().threads[id]?.updatedAt === stamps[id]));
  set((s) => ({ previews: { ...s.previews, ...current } }));
  try { localStorage.setItem(PREVIEWS_KEY, JSON.stringify(get().previews)); }
  catch { /* The cache only speeds up the next launch. */ }
  return current;
}

const focusedPreviewReads = new Map<string, Promise<ThreadPreview | null>>();
export async function previewForThread(thread: ThreadShell): Promise<ThreadPreview | null> {
  const stamp = thread.updatedAt || thread.latestRunCompletedAt || thread.latestRunStartedAt || new Date().toISOString();
  if (!thread.id) return null;
  const key = `${thread.id}:${stamp}`;
  const pending = focusedPreviewReads.get(key);
  if (pending) return pending;
  let read!: Promise<ThreadPreview | null>;
  read = api.threadPreviews({ [thread.id]: stamp })
    .then((previews) => previews[thread.id] ?? null)
    .catch(() => null)
    .finally(() => { if (focusedPreviewReads.get(key) === read) focusedPreviewReads.delete(key); });
  focusedPreviewReads.set(key, read);
  return read;
}

let taskSub: StreamHandle | null = null;
export function subscribeTasks() {
  taskSub?.cancel();
  taskSub = t3.stream("scheduledTasks.subscribe", {}, (it) => set({ tasks: it.tasks ?? [] }));
}

export async function setTaskEnabled(id: string, enabled: boolean) {
  await t3.call("scheduledTasks.setEnabled", { id, enabled });
}

export async function runTaskNow(id: string) {
  await t3.call("scheduledTasks.runNow", { id });
}

export async function deleteTask(id: string) {
  await t3.call("scheduledTasks.delete", { id });
}

// ---------- selectors ----------
export function botProject(bot: Bot, s = get()) {
  return bot.projectId ? s.projects[bot.projectId] : undefined;
}

export function mainThread(bot: Bot, s = get()) {
  return bot.mainThreadId ? s.threads[bot.mainThreadId] : undefined;
}

export function botReferenceKey(bot: Bot) {
  return get().bots[bot.slug]?.mainThreadId === bot.mainThreadId ? bot.slug : `archived:${bot.mainThreadId}`;
}

export function isSnoozed(thread: ThreadShell | undefined, now = Date.now()) { return !!thread?.snoozedUntil && Date.parse(thread.snoozedUntil) > now; }
export function isSettled(thread: ThreadShell | undefined) { return thread?.settledOverride === "settled" || (thread?.settledOverride !== "active" && !!thread?.settledAt); }

export function botStatus(bot: Bot, s = get()): BotStatus {
  const t = mainThread(bot, s);
  if (!t) return "new";
  if (t.pendingRuntimeRequest) return "waiting";
  if (["preparing", "queued", "starting", "running", "waiting"].includes(t.activityRunStatus ?? t.status)) return "working";
  const last = t.latestVisibleMessage;
  const unreadAt = t.latestRunCompletedAt === undefined ? (last?.role === "assistant" ? last.updatedAt : null) : t.latestRunCompletedAt;
  if (unreadAt && (!t.lastVisitedAt || unreadAt > t.lastVisitedAt) && s.selected !== bot.slug) return "unread";
  if (isSettled(t) && s.settings?.beta?.settleBotThreads !== true) return t.status === "failed" ? "failed" : "done";
  if (t.status === "failed" || t.lastErrorClass) return "failed";
  return "idle";
}

// The user's T3 defaults: Claude Opus 5.5 at medium effort, then GPT-6.1 Sol.
const PREFERRED_MODEL: ModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] };
const FALLBACK_MODEL: ModelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };

export function defaultModel(s = get()): ModelSelection | null {
  if (s.settings?.defaultModel) return s.settings.defaultModel;
  if (s.providers.length === 0) return PREFERRED_MODEL;
  const available = (sel: ModelSelection) => s.providers.some((p) => p.instanceId === sel.instanceId && p.models.some((m) => m.slug === sel.model));
  if (available(PREFERRED_MODEL)) return PREFERRED_MODEL;
  if (available(FALLBACK_MODEL)) return FALLBACK_MODEL;
  const first = s.providers.find((p) => p.models.length > 0);
  return first ? { instanceId: first.instanceId, model: (first.models.find((m) => m.isDefault) ?? first.models[0]).slug } : null;
}

export function runtimeMode(s = get()) {
  return s.settings?.autoReview === false ? "full-access" : "auto";
}

export function archivedInT3(bot: Bot, projects: Record<string, ProjectShell>) {
  return !bot.primary && !!bot.projectId && !!projects[bot.projectId]?.archivedAt;
}

export async function unarchiveBotProject(bot: Bot) {
  if (!bot.projectId) return;
  await t3.call("projects.mutate", { type: "project.update", commandId: uuid(), projectId: bot.projectId, archived: false });
  set((s) => { const project = bot.projectId ? s.projects[bot.projectId] : undefined; return project ? { projects: { ...s.projects, [project.id]: { ...project, archivedAt: null } } } : {}; });
}

// ---------- bot mutations ----------
let botMutations: Promise<unknown> = Promise.resolve();
function publishBots(bots: Bot[]) {
  set({ bots: Object.fromEntries(bots.map((bot) => [bot.slug, bot])) });
}
function mutateBots<T>(operation: () => Promise<T>): Promise<T> {
  storeShared.botsRevision++;
  storeShared.pendingBotMutations++;
  const result = botMutations.then(operation).finally(() => { storeShared.pendingBotMutations--; storeShared.botsRevision++; });
  botMutations = result.catch(() => {});
  return result;
}

export async function createBot(input: { name: string; label?: string; instructions?: string; shape: string; color: string; avatarImage?: string | null; avatarDefinition?: unknown; model?: ModelSelection | null; section?: string | null; primary?: boolean }) {
  const model = input.model ?? defaultModel();
  if (!model) throw new Error("No agent provider is ready on T3");
  const bot = await mutateBots(async () => {
    const created = await api.createBot({ ...input, section: input.section ?? null, model });
    if (isCustomColor(input.color)) rememberColor(input.color);
    publishBots(await api.bots());
    if (!created.mainThreadId) throw new Error("The Bot was created but T3 didn't start its conversation");
    return created;
  });
  select(bot.slug);
  return bot;
}

export function setMainBot(slug: string) {
  return mutateBots(async () => {
    const { bots } = await api.setMainBot(slug);
    publishBots(bots);
  });
}

export function updateBot(slug: string, patch: Partial<Bot>) {
  return mutateBots(async () => {
    const bot = get().bots[slug];
    if (!bot) return;
    await api.saveBot(slug, patch);
    if (isCustomColor(patch.color)) rememberColor(patch.color);
    publishBots(await api.bots());
    if (patch.name && bot.projectId && !bot.adopted) {
      await t3.call("projects.mutate", { type: "project.update", commandId: uuid(), projectId: bot.projectId, title: patch.name }).catch(() => {});
    }
  });
}

export async function adoptProject(input: { projectId: string; threadId: string | null; name: string; shape: string; color: string; avatarImage?: string | null; avatarDefinition?: unknown; primary?: boolean }) {
  const model = defaultModel();
  const bot = await mutateBots(async () => {
    const created = await api.adoptProject({ ...input, section: null, model });
    if (isCustomColor(input.color)) rememberColor(input.color);
    publishBots(await api.bots());
    if (!created.mainThreadId) throw new Error("The Bot was made but T3 didn't start its conversation");
    return created;
  });
  select(bot.slug);
  return bot;
}

export function releaseBot(slug: string) {
  return mutateBots(async () => {
    const { bots, archive } = await api.releaseBot(slug);
    publishBots(bots);
    set((s) => ({ selected: s.selected === slug ? null : s.selected, selectedThreadId: s.selected === slug ? null : s.selectedThreadId, exchangeBotSlug: s.exchangeBotSlug === slug ? null : s.exchangeBotSlug }));
    return archive;
  });
}

export function deleteBot(slug: string) {
  return mutateBots(async () => {
    const bot = get().bots[slug];
    if (!bot) return;
    if (bot.adopted) throw new Error("This Bot was made from a project. Turn it back into a plain project instead.");
    const { bots } = await api.deleteBot(slug);
    publishBots(bots);
    keepBoot({ botsRoot: get().botsRoot, executorUrl: get().executorUrl, settings: get().settings, bots, historical: Object.values(get().historicalBots) });
    forgetThreadCopy(Object.values(get().threads).filter((thread) => thread.id === bot.mainThreadId || (bot.projectId && thread.projectId === bot.projectId)).map((thread) => thread.id).concat(bot.mainThreadId ? [bot.mainThreadId] : []));
    set((s) => ({ selected: s.selected === slug ? null : s.selected, selectedThreadId: s.selected === slug ? null : s.selectedThreadId, exchangeBotSlug: s.exchangeBotSlug === slug ? null : s.exchangeBotSlug }));
    if (bot.mainThreadId) set((s) => ({ historicalBots: { ...s.historicalBots, [`archived:${bot.mainThreadId}`]: { ...bot, hidden: true, pinned: false, primary: false, creator: false, notifications: false } } }));
    if (bot.mainThreadId) await t3.dispatch({ type: "thread.stop", threadId: bot.mainThreadId }).catch(() => {});
    if (bot.projectId) await t3.call("projects.mutate", { type: "project.delete", commandId: uuid(), projectId: bot.projectId, force: true }).catch((e) => console.warn(e));
  });
}

export async function setBotModel(slug: string, model: ModelSelection) {
  const bot = get().bots[slug];
  if (!bot?.projectId) return;
  await t3.call("projects.mutate", { type: "project.update", commandId: uuid(), projectId: bot.projectId, defaultModelSelection: model });
  if (bot.mainThreadId) await t3.dispatch({ type: "thread.model-selection.set", threadId: bot.mainThreadId, modelSelection: model });
}

// ---------- avatar drawing & model helpers ----------
const DRAWING_JOB_TITLE_CONST = "Avatar drawing";
void DRAWING_JOB_TITLE_CONST;

export function avatarDrawingModel(bot: Bot, s = get()) {
  const own = (bot.mainThreadId ? s.threads[bot.mainThreadId]?.modelSelection : null) ?? (bot.projectId ? s.projects[bot.projectId]?.defaultModelSelection : null) ?? defaultModel(s);
  return drawingModel(s.providers, s.settings?.avatarDrawingModel, own ?? null);
}

export async function startAvatarDrawing(bot: Bot, description: string, options = DRAWING_OPTIONS) {
  const main = bot.mainThreadId ? get().threads[bot.mainThreadId] : undefined;
  if (!get().runtimeFeatures.sideChats || !bot.projectId || (main?.archivedAt || main?.lineage.relationshipToParent === "subagent")) {
    throw new Error("Drawing needs a newer T3 Code, with side chats.");
  }
  const model = avatarDrawingModel(bot);
  if (!model) throw new Error("No model is available to draw with.");
  const { drawingsOf, DRAWING_JOB_TITLE } = await import("../lib/avatarDrawing");
  await discardAvatarDrawing(drawingsOf(get().threads, bot));
  const jobId = uuid();
  const actor = { createdBy: "user", creationSource: "web" };
  try {
    await t3.dispatch({ type: "thread.create", ...actor, threadId: jobId, projectId: bot.projectId, title: DRAWING_JOB_TITLE, modelSelection: model, runtimeMode: runtimeMode(), interactionMode: "default", branch: null, worktreePath: null }, { timeoutMs: 30_000 });
    await t3.dispatch({ type: "thread.archive", threadId: jobId });
    const started = await Promise.allSettled(Array.from({ length: options }, async (_, index) => {
      const threadId = uuid();
      await t3.dispatch({ type: "thread.fork", ...actor, sourceThreadId: jobId, targetThreadId: threadId, sourcePoint: { type: "latest_stable" }, sideChat: true, title: drawingTitle(description) }, { timeoutMs: 30_000 });
      try {
        if (!await threadArrives(threadId)) throw new Error("The drawing didn't reach this device. Try again.");
        await sendMessage(bot.slug, drawingPrompt(description, index + 1, options), [], threadId);
      } catch (error) {
        await t3.dispatch({ type: "thread.delete", threadId }).catch(() => {});
        throw error;
      }
      return threadId;
    }));
    const running = started.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!running.length) throw (started[0] as PromiseRejectedResult).reason;
    superviseDrawing(running);
  } catch (error) {
    void t3.dispatch({ type: "thread.delete", threadId: jobId }).catch(() => {});
    throw error;
  }
}

const drawingReads = new Map<string, Promise<DrawingOption>>();
const drawingReadKey = (thread: ThreadShell) => `${thread.id}:${thread.latestRunId}:${thread.latestRunCompletedAt ?? ""}`;

export function readDrawingOption(thread: ThreadShell): Promise<DrawingOption> {
  const key = drawingReadKey(thread);
  const known = drawingReads.get(key);
  if (known) return known;
  const read = threadClient(thread.id).call<{ turnItems: TurnItem[]; runs?: Run[] }>("orchestration.getThreadProjection", { threadId: threadTarget(thread.id).threadId })
    .then(async (projection): Promise<DrawingOption> => {
      const { retry, ...result } = drawingResult(thread, projection.turnItems ?? [], projection.runs ?? []);
      if (retry === undefined) return result;
      const bot = Object.values(get().bots).find((candidate) => candidate.projectId === thread.projectId);
      if (!bot) return { status: "failed", thread, error: retry };
      await sendMessage(bot.slug, fixPrompt(retry), [], thread.id);
      return result;
    })
    .catch((): DrawingOption => { drawingReads.delete(key); return { status: "failed", thread, error: "Couldn't read the drawing. Try again." }; });
  drawingReads.set(key, read);
  return read;
}

function superviseDrawing(threadIds: string[]) {
  const settled = new Set<string>();
  const seen = new Set<string>();
  const check = (state: State) => {
    for (const id of threadIds) {
      const thread = state.threads[id];
      if (!thread) { settled.add(id); continue; }
      if (settled.has(id) || !(thread.status === "running" || thread.status === "starting" || thread.status === "queued" || thread.status === "preparing")) {
        const key = drawingReadKey(thread);
        if (!seen.has(key)) {
          seen.add(key);
          void readDrawingOption(thread).then((option) => { if (option.status !== "fixing") settled.add(id); });
        }
      }
    }
    if (threadIds.every((id) => settled.has(id))) { clearTimeout(timer); stop(); }
  };
  const stop = useApp.subscribe(check);
  const timer = setTimeout(stop, 10 * 60_000);
}

export async function discardAvatarDrawing(options: ThreadShell[]) {
  const mains = new Set(Object.values(get().bots).map((bot) => bot.mainThreadId));
  const jobs = new Set(options.map((thread) => thread.lineage.parentThreadId).filter((id): id is string => !!id && !mains.has(id)));
  await Promise.all(options.map(async (thread) => {
    if (get().threads[thread.id]?.activeRunId) await interrupt(thread.id).catch(() => {});
    await t3.dispatch({ type: "thread.delete", threadId: thread.id });
  }));
  for (const job of jobs) await t3.dispatch({ type: "thread.delete", threadId: job }).catch(() => {});
  const gone = new Set(options.map((thread) => thread.id));
  set((s) => ({ threads: Object.fromEntries(Object.entries(s.threads).filter(([id]) => !gone.has(id))) }));
}

export async function saveFallbackModel(selection: ModelSelection | null) {
  const settings = await t3.call("server.updateSettings", { patch: { fallbackModelSelection: selection } });
  set({ fallbackModel: settings?.fallbackModelSelection ?? null });
}

export function resolvedSnoozes(presets = get().snoozePresets, now = new Date()) {
  return presets.flatMap((preset) => {
    const date = new Date(now);
    let label: string;
    if (preset.kind === "after") { date.setMinutes(date.getMinutes() + preset.minutes); label = preset.minutes < 60 ? `For ${preset.minutes} minutes` : preset.minutes === 60 ? "For 1 hour" : `For ${preset.minutes / 60} hours`; }
    else {
      const [hours, minutes] = preset.time.split(":").map(Number); date.setHours(hours, minutes, 0, 0);
      if (preset.day === "tomorrow") date.setDate(date.getDate() + 1);
      else if (preset.day !== "today") { const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(preset.day); date.setDate(date.getDate() + ((day - date.getDay() + 7) % 7 || 7)); }
      label = `${preset.day[0].toUpperCase()}${preset.day.slice(1)} at ${preset.time}`;
    }
    return date > now ? [{ label, snoozedUntil: date.toISOString() }] : [];
  });
}

let settingsSaves: Promise<unknown> = Promise.resolve();
function queueSettingsSave<T>(operation: () => Promise<T>) {
  const result = settingsSaves.then(operation);
  settingsSaves = result.catch(() => {});
  return result;
}

export function saveSettings(patch: Partial<Settings>) {
  return queueSettingsSave(() => persistSettings(patch));
}

export function ensureBotSection(name: string) {
  return queueSettingsSave(async () => {
    const section = name.trim();
    const sections = get().settings?.sections ?? [];
    const existing = sections.find((entry) => entry.toLowerCase() === section.toLowerCase());
    if (existing) return existing;
    await persistSettings({ sections: [...sections, section] });
    return section;
  });
}

async function persistSettings(patch: Partial<Settings>) {
  let next: Settings;
  try { next = await api.saveSettings(patch); }
  catch (error) {
    const confirmed = await api.settings().catch(() => null);
    if (confirmed) set({ settings: confirmed });
    throw error;
  }
  set({ settings: next });
  if ("autoReview" in patch) {
    const mode = runtimeMode();
    await Promise.all(
      Object.values(get().bots)
        .filter((b) => b.mainThreadId)
        .map((b) => t3.dispatch({ type: "thread.runtime-mode.set", threadId: b.mainThreadId, runtimeMode: mode }).catch(() => {})),
    );
  }
}
