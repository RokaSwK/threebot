// Web Push for the installed PWA: VAPID keys and browser subscriptions live in one JSON file,
// and the gateway watches T3's thread shell for finished or waiting Bots. A push only says which
// Bot and a short preview; the actual conversation stays in T3.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateVAPIDKeys, sendNotification, WebPushError } from "web-push";
import type { Bot } from "./main-bot.mts";
import type { T3Client } from "./t3rpc.mts";
import { botIdentity } from "./bot-icons.mts";
import { effectiveAlerts, routineOwner, routinePlace, routineTag, type RoutineRecord } from "./routine-alerts.mts";

const MAX_SUBSCRIPTIONS = 20;
const MAX_ENDPOINT = 2_048;
// A device that is looking at a Bot says so every few seconds; the claim lapses on its own if the
// page goes away without saying goodbye.
const WATCHING_MS = 30_000;
const FALLBACK_SUBJECT = "mailto:threebot@localhost";

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
};

type PushState = {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
  /** The app's own address, learned from the browser that subscribed. Signs pushes when nothing is configured. */
  origin?: string;
};

export type PushPayload = {
  title: string;
  body: string;
  tag: string;
  url: string;
  /** The Bot this push is about. A room push leaves it out and sets `room` instead. */
  bot?: string;
  /** The room this push is about. A room push is held back on the device looking at that room. */
  room?: string;
  /** The conversation this push is about, when it is not the Bot's chat. Presence is compared per thread. */
  thread?: string;
  /** The Bot's picture or drawn avatar, served by the gateway. */
  icon?: string;
  /** Android's monochrome status-bar icon: the Bot's silhouette, or Threebot's for a photo. */
  badge?: string;
  /** Small data: copies of icon and badge, shown when the device can't fetch them (offline, signed out). */
  iconData?: string;
  badgeData?: string;
  /** When the event happened, for clients that show it. */
  timestamp?: number;
  /** "resolved" closes the notification with this tag instead of showing one (see quietClose). */
  kind?: "finished" | "waiting" | "failed" | "resolved";
};

// What a presence report may name: a Bot reference as the page keeps it (a slug, or
// `archived:<thread id>`), a room id and a conversation. Anything else is a malformed report.
const BOT_VIEW = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const ROOM_VIEW = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THREAD_VIEW = /^[A-Za-z0-9][A-Za-z0-9:_.%-]{0,299}$/;

/**
 * What a device says it is looking at, as one key: a room, a conversation, or the Bot's chat. null
 * means nothing (looked away); undefined means the report is malformed. All of it arrives from the
 * page, so it is untrusted text and is compared, never used as a path. A room wins over a thread,
 * and a thread over the Bot's chat: a notice about another conversation must still arrive while the
 * user reads the Bot's main one.
 */
function viewKey(bot: unknown, room: unknown, thread: unknown): string | null | undefined {
  const absent = (value: unknown) => value === undefined || value === null || value === "";
  if (!absent(room) && !(typeof room === "string" && ROOM_VIEW.test(room))) return undefined;
  if (!absent(bot) && !(typeof bot === "string" && BOT_VIEW.test(bot))) return undefined;
  if (!absent(thread) && !(typeof thread === "string" && THREAD_VIEW.test(thread))) return undefined;
  if (typeof room === "string" && room) return `room:${room}`;
  if (typeof thread === "string" && thread) return `thread:${thread}`;
  return typeof bot === "string" && bot ? `bot:${bot}` : null;
}

type VapidDetails = { subject: string; publicKey: string; privateKey: string };
type Sender = (subscription: PushSubscription, payload: string, options?: { TTL?: number; urgency?: string; vapidDetails?: VapidDetails; topic?: string }) => Promise<unknown>;

function record(value: unknown): PushSubscriptionRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length > MAX_ENDPOINT) return null;
  let url: URL;
  try { url = new URL(candidate.endpoint); } catch { return null; }
  // Web Push endpoints are HTTPS. Allow the localhost form only for a browser test server.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) return null;
  if (typeof candidate.keys?.p256dh !== "string" || typeof candidate.keys?.auth !== "string") return null;
  if (candidate.keys.p256dh.length < 16 || candidate.keys.p256dh.length > 512 || candidate.keys.auth.length < 8 || candidate.keys.auth.length > 256) return null;
  return { endpoint: candidate.endpoint, keys: { p256dh: candidate.keys.p256dh, auth: candidate.keys.auth }, createdAt: "" };
}

/**
 * A contact a push service will accept: a mailto: or https: address on a real domain. Apple answers
 * 403 BadJwtToken to localhost, .local and bare host names, so those are not usable.
 */
export function usableSubject(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  let host: string;
  if (/^mailto:/iu.test(text)) {
    const address = text.slice("mailto:".length);
    if (/[\s<>]/u.test(address) || address.split("@").length !== 2) return null;
    host = address.split("@")[1]!.toLowerCase();
  } else {
    let url: URL;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol !== "https:") return null;
    host = url.hostname.toLowerCase();
  }
  if (!host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || /^[\d.]+$/u.test(host) || host.includes(":")) return null;
  return /^mailto:/iu.test(text) ? text : new URL(text).origin;
}

/**
 * RFC 8030 Topic: while a device is offline, its push service keeps only the latest message with
 * this topic, so it wakes up with one notice instead of a burst. The notification tag is the same
 * identifier; a value that does not fit the 32-character base64url limit is hashed.
 */
// Push services take about 4 KB of payload; encryption adds about 100 bytes. The small embedded
// images go first when a message would not fit (the full-size URLs remain).
const MAX_PAYLOAD = 3_500;
const clipText = (text: string, length: number) => [...text].length > length ? [...text].slice(0, length - 1).join("") + "…" : text;
export function fitPayload(payload: PushPayload): PushPayload {
  const fits = (candidate: PushPayload) => Buffer.byteLength(JSON.stringify(candidate)) <= MAX_PAYLOAD;
  // Text gives way first, so the Bot's face stays; then the embedded images; then the text again.
  let fitted = fits(payload) ? payload : { ...payload, title: clipText(payload.title, 80), body: clipText(payload.body, 80) };
  for (const field of ["iconData", "badgeData"] as const) {
    if (fits(fitted)) return fitted;
    const { [field]: _dropped, ...rest } = fitted;
    fitted = rest;
  }
  return fits(fitted) ? fitted : { ...fitted, title: clipText(fitted.title, 24), body: clipText(fitted.body, 24) };
}

export function pushTopic(tag: string): string {
  return /^[A-Za-z0-9_-]{1,32}$/.test(tag) ? tag : createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/**
 * Whether this push service may get a "resolved" push. Safari revokes a subscription after a few
 * pushes that show nothing and ignores tags (a replacement would stack), so a Safari device keeps the
 * stale notice until the app opens and clears it.
 */
export function quietClose(endpoint: string): boolean {
  try { return !/(^|\.)push\.apple\.com$/u.test(new URL(endpoint).hostname); } catch { return false; }
}

/** Firefox spends a quota on a push that shows nothing, so there a resolution always leaves a quiet notice. */
function mustShow(endpoint: string): boolean {
  try { return /(^|\.)push\.services\.mozilla\.com$/u.test(new URL(endpoint).hostname); } catch { return false; }
}

/** VAPID keys and push subscriptions. The private key never leaves this file or the server. */
export function createPushStore({
  file,
  subject = process.env.VAPID_SUBJECT,
  appUrl = process.env.APP_URL,
  sender = sendNotification as unknown as Sender,
  generateKeys = generateVAPIDKeys,
  now = () => new Date(),
}: {
  file: string;
  /** VAPID_SUBJECT. Used as given when set; otherwise the app's own address signs the push. */
  subject?: string;
  appUrl?: string;
  sender?: Sender;
  generateKeys?: () => { publicKey: string; privateKey: string };
  now?: () => Date;
}) {
  let state: PushState | null = null;
  let writes = Promise.resolve();
  const watching = new Map<string, { view: string; until: number }>();

  async function load(): Promise<PushState> {
    if (state) return state;
    let parsed: Partial<PushState> | null = null;
    try { parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<PushState>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("push: couldn't read its store", error);
    }
    const keys = parsed?.vapid && typeof parsed.vapid.publicKey === "string" && typeof parsed.vapid.privateKey === "string"
      ? parsed.vapid : generateKeys();
    const subscriptions = Array.isArray(parsed?.subscriptions)
      ? parsed.subscriptions.map(record).filter((item): item is PushSubscriptionRecord => item !== null).map((item) => ({ ...item, createdAt: item.createdAt || now().toISOString() })).slice(0, MAX_SUBSCRIPTIONS)
      : [];
    const origin = usableSubject(parsed?.origin);
    state = { vapid: keys, subscriptions, ...(origin ? { origin } : {}) };
    await save();
    return state;
  }

  function save(): Promise<void> {
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
    return writes;
  }

  return {
    async publicKey(): Promise<string> {
      return (await load()).vapid.publicKey;
    },

    /** How many browsers/devices have a subscription. */
    async devices(): Promise<number> {
      return (await load()).subscriptions.length;
    },

    /** Whether this exact endpoint is subscribed here (a refused registration is not). */
    async has(endpoint: unknown): Promise<boolean> {
      return typeof endpoint === "string" && (await load()).subscriptions.some((subscription) => subscription.endpoint === endpoint);
    },

    /**
     * `replaces`: the worker renewing a rotated subscription. The check and the swap happen in one
     * step: if that endpoint is gone (the device turned push off), the renewal is refused.
     */
    async subscribe(value: unknown, origin?: unknown, replaces?: string): Promise<{ ok: true; subscriptions: number } | { ok: false; message: string; off?: true }> {
      const item = record(value);
      if (!item) return { ok: false, message: "The push subscription is invalid." };
      const current = await load();
      if (replaces !== undefined && !current.subscriptions.some((subscription) => subscription.endpoint === replaces)) {
        return { ok: false, message: "Push is off on this device.", off: true };
      }
      const from = usableSubject(origin);
      if (from) current.origin = from;
      const others = current.subscriptions.filter((subscription) => subscription.endpoint !== item.endpoint && subscription.endpoint !== replaces);
      if (others.length >= MAX_SUBSCRIPTIONS) {
        return { ok: false, message: "This install already has the maximum number of push devices." };
      }
      if (replaces !== undefined && replaces !== item.endpoint) watching.delete(replaces);
      current.subscriptions = [...others, { ...item, createdAt: now().toISOString() }];
      await save();
      return { ok: true, subscriptions: current.subscriptions.length };
    },

    async unsubscribe(endpoint: unknown): Promise<{ ok: true; subscriptions: number }> {
      const current = await load();
      if (typeof endpoint === "string") {
        current.subscriptions = current.subscriptions.filter((subscription) => subscription.endpoint !== endpoint);
        watching.delete(endpoint);
      }
      await save();
      return { ok: true, subscriptions: current.subscriptions.length };
    },

    /**
     * A device says which room, conversation or Bot's chat it has open and in focus, or nothing
     * when it looks away. A push about that same thing is not sent to that device: the browser
     * must show every push it receives (Safari drops a subscription after three it didn't show),
     * so what is already on screen isn't sent. A room wins over a thread, and a thread over the Bot.
     */
    async presence(endpoint: unknown, bot: unknown, room: unknown = null, thread: unknown = null): Promise<{ ok: true; watching: boolean } | { ok: false; message: string }> {
      const view = viewKey(bot, room, thread);
      if (view === undefined) return { ok: false, message: "bot, room and thread must be a Bot reference, a room id, a conversation or null." };
      const current = await load();
      if (typeof endpoint !== "string" || !current.subscriptions.some((subscription) => subscription.endpoint === endpoint)) return { ok: true, watching: false };
      if (!view) {
        watching.delete(endpoint);
        return { ok: true, watching: false };
      }
      watching.set(endpoint, { view, until: now().getTime() + WATCHING_MS });
      return { ok: true, watching: true };
    },

    async send(message: PushPayload, options?: { endpoint?: string }): Promise<{ sent: number; removed: number; watching: number }> {
      const payload = fitPayload(message);
      const current = await load();
      if (!current.subscriptions.length) return { sent: 0, removed: 0, watching: 0 };
      // The app's own address when nothing is configured: Apple refuses a localhost contact.
      const vapidDetails = { subject: subject?.trim() || usableSubject(appUrl) || current.origin || FALLBACK_SUBJECT, publicKey: current.vapid.publicKey, privateKey: current.vapid.privateKey };
      let sent = 0;
      let skipped = 0;
      // Sends await the network: the live list may change meanwhile (an unsubscribe, a new device),
      // so iterate a copy, skip what was removed, and prune only the endpoints that are gone.
      const gone = new Set<PushSubscriptionRecord>();
      const time = now().getTime();
      // A push is about one thing: a room, a conversation, or a Bot. With none there is nothing to hold back.
      const target = payload.room ? `room:${payload.room}` : payload.thread ? `thread:${payload.thread}` : payload.bot ? `bot:${payload.bot}` : null;
      for (const { endpoint } of [...current.subscriptions]) {
        // The record as it is now: removed meanwhile (skip it), or replaced by a fresh registration.
        const subscription = current.subscriptions.find((record) => record.endpoint === endpoint);
        if (!subscription) continue;
        // The Settings test names the device that asked; every other subscription stays untouched.
        if (options?.endpoint && subscription.endpoint !== options.endpoint) continue;
        if (payload.kind === "resolved" && !quietClose(subscription.endpoint)) continue;
        const seen = watching.get(subscription.endpoint);
        if (seen && seen.until <= time) watching.delete(subscription.endpoint);
        // A resolution is not held back: a device that just looked away may still show the notice.
        else if (target && seen?.view === target && payload.kind !== "resolved") {
          skipped += 1;
          continue;
        }
        try {
          // The same topic as the "waiting" push it answers: a device that was offline gets only this one.
          await sender(subscription as unknown as PushSubscription, JSON.stringify(payload.kind === "resolved" && mustShow(subscription.endpoint) ? { ...payload, show: true } : payload), { TTL: 3_600, urgency: payload.kind === "resolved" ? "normal" : "high", vapidDetails, topic: pushTopic(payload.tag) });
          sent += 1;
        } catch (error) {
          const status = error instanceof WebPushError ? error.statusCode : 0;
          if (status === 404 || status === 410) {
            gone.add(subscription);
          } else {
            console.error("push: send failed", status || (error as Error).message);
          }
        }
      }
      if (gone.size > 0) {
        // Only the records that failed: a registration made since then is a new, working one.
        current.subscriptions = current.subscriptions.filter((subscription) => !gone.has(subscription));
        // Presence goes with the endpoint, unless the device registered it again meanwhile.
        for (const { endpoint } of gone) if (!current.subscriptions.some((record) => record.endpoint === endpoint)) watching.delete(endpoint);
        await save();
      }
      return { sent, removed: gone.size, watching: skipped };
    },
  };
}

type ShellThread = {
  id: string;
  projectId?: string | null;
  status: string;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: unknown;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
  lineage?: { rootThreadId?: string | null; parentThreadId?: string | null; relationshipToParent?: string | null; sideChat?: boolean } | null;
  latestRunStartedAt?: string | null;
  latestRunRequestedAt?: string | null;
  latestUserMessageAt?: string | null;
  updatedAt?: string | null;
};

/** The newest visible item of a thread, as the app's own preview reports it. */
export type PushPreview = { role: string; text: string; at: string | null; routine?: { taskId: string; runId: string } };

/** What the gateway's task subscription says about a routine, as far as alerts read it. */
type RoutineTask = { id: string; title: string; projectId?: string | null; threadId?: string | null; threadMode?: string | null; lastRunAt?: string | null; lastRunStatus?: string | null };
type RoutineMatch = { task: RoutineTask; bot: Bot; place: "chat" | "own" | "new"; alerts: ReturnType<typeof effectiveAlerts> };
type TaskEvent = { tasks?: RoutineTask[] };

type ShellEvent = {
  kind: string;
  resolvedRepositoryIdentityRoots?: unknown;
  snapshot?: { threads?: ShellThread[] };
  thread?: ShellThread;
  threadId?: string;
  location?: string;
};

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * A notification that needs the user belongs to one conversation. A completion stays one per Bot:
 * three finished runs leave one updated notification, not three.
 */
export function waitingTag(slug: string, threadId: string): string {
  return `waiting:${slug}:${threadId}`;
}

/**
 * Watch T3's shell stream and turn transitions into pushes. The first snapshot only seeds state.
 * The rules are the page's own (notifyIfNeeded in web/src/store.ts), so a phone hears what the open
 * app would have said: a Bot's main conversation finishing or asking for the user, a side chat
 * asking for the user, and a routine when its per-routine alert says so. Subagents and snoozed
 * threads stay quiet. With `routines`, a second subscription carries T3's tasks (the only
 * scheduler) so a run can be attributed to its routine without polling or reading every thread.
 */
export function createPushNotifier({
  connect,
  bots,
  send,
  preview,
  routines,
  retryMs = 5_000,
  log = (line: string) => console.log(line),
  now = () => new Date(),
}: {
  connect: () => Promise<T3Client>;
  bots: () => Promise<Bot[]>;
  send: (payload: PushPayload) => Promise<unknown>;
  preview?: (threadId: string, stamp: string | null) => Promise<PushPreview | null>;
  /** Routine records from the gateway's store. Without it, routines stay on the old Bot-only path. */
  routines?: { alerts: (taskId: string) => Promise<RoutineRecord | null> };
  retryMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}) {
  const previous = new Map<string, ShellThread>();
  /** Tasks from T3's own subscription; empty until it answers, so no routine is invented. */
  let routineTasks: RoutineTask[] = [];
  /** The last routine notice per conversation, so an answer can close it after the wait is gone. */
  const routineThreads = new Map<string, { bot: string; title: string }>();
  /** The last task dispatch state; a failed dispatch is only news when it changes here. */
  const taskStates = new Map<string, string>();
  let stopped = false;
  let stream: ReturnType<T3Client["stream"]> | null = null;
  let taskStream: ReturnType<T3Client["stream"]> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started: Promise<void> | null = null;

  const sideChat = (thread: ShellThread) => thread.lineage?.sideChat === true;
  const childThread = (thread: ShellThread) => sideChat(thread) || !!thread.lineage?.parentThreadId || thread.lineage?.relationshipToParent === "subagent";
  const taskMode = (task: RoutineTask) => task.threadMode ?? (task.threadId === null ? "new_thread" : "continue");

  /** The Bot a thread notifies for. `any`: also a hidden or muted Bot, whose earlier notice still needs clearing. */
  async function ownerFor(thread: ShellThread, any = false): Promise<Bot | null> {
    const mainThreadId = sideChat(thread) ? thread.lineage?.parentThreadId : thread.id;
    if (!mainThreadId) return null;
    return (await bots()).find((bot) => (any || (!bot.hidden && bot.notifications !== false)) && bot.mainThreadId === mainThreadId) ?? null;
  }

  /** Tasks T3 bound to this exact conversation. A new-thread task has no thread until it runs. */
  const boundTasks = (thread: ShellThread) => routineTasks.filter((task) => task.threadId === thread.id && taskMode(task) !== "new_thread");

  /** Whether any routine could own this thread: bound to it, or a new thread in its project. */
  const routineCandidate = (thread: ShellThread) => boundTasks(thread).length > 0
    || routineTasks.some((task) => taskMode(task) === "new_thread" && task.projectId === thread.projectId);

  /**
   * Whether a waiting request needs a projection read to know if a routine owns it. Only an
   * explicit preference can change what this feature does, so an untouched install pays nothing.
   */
  async function needsWaitingEvidence(thread: ShellThread): Promise<boolean> {
    if (!routines) return false;
    for (const task of boundTasks(thread)) {
      const record = await routines.alerts(task.id).catch(() => null);
      if (record?.alerts && typeof record.alerts.waiting === "boolean") return true;
    }
    for (const task of routineTasks.filter((task) => taskMode(task) === "new_thread" && task.projectId === thread.projectId)) {
      const record = await routines.alerts(task.id).catch(() => null);
      if (record?.alerts?.waiting === true) return true;
    }
    return false;
  }

  /**
   * The routine that owns a run, or null. An explicit link wins; a single bound task is proof;
   * a new-thread run must carry T3's own `scheduledTaskId` evidence. Subagents never qualify.
   */
  async function routineFor(thread: ShellThread, evidence: PushPreview["routine"] | null, any = false): Promise<RoutineMatch | null> {
    if (!routines || childThread(thread)) return null;
    const evidenceTask = evidence ? routineTasks.find((entry) => entry.id === evidence.taskId) ?? null : null;
    // Only T3's scheduledTaskId evidence ties the run to a routine. A task bound to the thread is
    // not proof: the user can chat in that conversation themselves, and that turn is not a result.
    if (!evidenceTask) return null;
    // A task from another project is not evidence for this conversation, whatever the projection says.
    if (evidenceTask.projectId && thread.projectId && evidenceTask.projectId !== thread.projectId) return null;
    const record = await routines.alerts(evidenceTask.id).catch(() => null);
    const owner = routineOwner(evidenceTask, await bots(), record);
    if (!owner || owner === "ambiguous") return null;
    if (owner.hidden && !any) return null;
    const place = routinePlace(evidenceTask, owner);
    return { task: evidenceTask, bot: owner, place, alerts: effectiveAlerts(record, place) };
  }

  function completionBody(thread: ShellThread, value: PushPreview | null): string | null {
    if (!value?.role || value.role !== "assistant" || !value.text.trim() || !value.at) return null;
    const runStarted = thread.latestRunStartedAt ?? thread.latestRunRequestedAt ?? thread.latestUserMessageAt;
    return !runStarted || value.at >= runStarted ? value.text.trim().slice(0, 140) : null;
  }

  async function sendRoutine(routine: RoutineMatch, thread: ShellThread, kind: "finished" | "waiting" | "failed", value?: PushPreview | null): Promise<void> {
    if (routine.bot.notifications === false) return;
    const waiting = kind === "waiting";
    const body = waiting ? "Needs attention" : kind === "failed" ? "The run failed" : completionBody(thread, value ?? null) ?? "Finished";
    routineThreads.set(thread.id, { bot: routine.bot.slug, title: routine.task.title });
    if (routineThreads.size > 200) routineThreads.delete(routineThreads.keys().next().value!);
    // Presence names a conversation. A run in the Bot's chat is the Bot's own view, not a thread key.
    const threadView = thread.id === routine.bot.mainThreadId ? undefined : thread.id;
    await send({
      // The Bot and the routine, so a lock-screen notice says which one needs the user.
      title: `${routine.bot.name} · ${routine.task.title}`,
      body,
      tag: waiting ? waitingTag(routine.bot.slug, thread.id) : routineTag(routine.task.id),
      url: `/?bot=${encodeURIComponent(routine.bot.slug)}&thread=${encodeURIComponent(thread.id)}`,
      bot: routine.bot.slug,
      ...(threadView ? { thread: threadView } : {}),
      ...await botIdentity(routine.bot),
      timestamp: Date.parse(thread.updatedAt ?? "") || Date.now(),
      kind,
    });
    log(`push: ${kind} ${routine.bot.slug} ${routine.task.id}`);
  }

  // One conversation's pushes go out in order: a "resolved" must reach the push service after the
  // "waiting" it answers, since both share a Topic and the later one replaces the earlier.
  const queues = new Map<string, Promise<void>>();
  function inOrder(threadId: string, work: () => Promise<void>) {
    const run = (queues.get(threadId) ?? Promise.resolve()).then(work).catch((error) => log(`push: ${(error as Error).message}`));
    queues.set(threadId, run);
    void run.finally(() => { if (queues.get(threadId) === run) queues.delete(threadId); });
  }

  /**
   * Whether a finished run needs a projection read: for the reply body of a Bot completion, to
   * attribute a chat routine, or to read an own/new-thread routine whose finished alert is on.
   * A normal thread in a project that merely has routines pays nothing.
   */
  async function finishedPreviewWanted(thread: ShellThread, owner: Bot | null): Promise<boolean> {
    if (!routines) return !!owner;
    const bound = boundTasks(thread);
    if (owner && bound.some((task) => task.threadId === owner.mainThreadId)) return true;
    for (const task of bound) {
      const record = await routines.alerts(task.id).catch(() => null);
      if (effectiveAlerts(record, "own").finished) return true;
    }
    for (const task of routineTasks.filter((task) => taskMode(task) === "new_thread" && task.projectId === thread.projectId)) {
      const record = await routines.alerts(task.id).catch(() => null);
      if (effectiveAlerts(record, "new").finished) return true;
    }
    return !!owner;
  }

  /** A task update that says the dispatch itself failed; only an explicit per-routine opt-in speaks. */
  async function notifyDispatchFailed(task: RoutineTask) {
    if (!routines || task.lastRunStatus !== "failed") return;
    const record = await routines.alerts(task.id).catch(() => null);
    const owner = routineOwner(task, await bots(), record);
    if (!owner || owner === "ambiguous" || owner.hidden || owner.notifications === false) return;
    if (!effectiveAlerts(record, routinePlace(task, owner)).failed) return;
    const threadView = task.threadId && task.threadId !== owner.mainThreadId ? task.threadId : undefined;
    await send({
      title: `${owner.name} · ${task.title}`,
      body: "The run could not be dispatched.",
      tag: routineTag(task.id),
      url: `/?bot=${encodeURIComponent(owner.slug)}${task.threadId ? `&thread=${encodeURIComponent(task.threadId)}` : ""}`,
      bot: owner.slug,
      ...(threadView ? { thread: threadView } : {}),
      ...await botIdentity(owner),
      timestamp: Date.parse(task.lastRunAt ?? "") || Date.now(),
      kind: "failed",
    });
    log(`push: dispatch_failed ${owner.slug} ${task.id}`);
  }

  async function notify(thread: ShellThread, kind: "finished" | "waiting") {
    const owner = await ownerFor(thread);
    // Only a finished run needs the reply for its body; a wait needs the projection only when an
    // explicit routine preference could change the answer. No polling: previews are cached by stamp.
    const value = preview && (kind === "waiting" ? await needsWaitingEvidence(thread) : await finishedPreviewWanted(thread, owner))
      ? await preview(thread.id, thread.updatedAt ?? null).catch(() => null)
      : null;
    const routine = await routineFor(thread, value?.routine ?? null);
    if (routine) {
      if (!routine.alerts[kind]) return;
      return sendRoutine(routine, thread, kind, value);
    }
    if (!owner) return;
    const body = kind === "finished"
      ? completionBody(thread, value) ?? "Finished"
      : sideChat(thread) ? "A side chat is waiting for you" : "Waiting for you";
    const waiting = kind === "waiting";
    await send({
      title: owner.name,
      body,
      tag: waiting ? waitingTag(owner.slug, thread.id) : owner.slug,
      url: waiting
        ? `/?bot=${encodeURIComponent(owner.slug)}&thread=${encodeURIComponent(thread.id)}`
        : `/?bot=${encodeURIComponent(owner.slug)}`,
      bot: owner.slug,
      // A side chat is a conversation of its own; the Bot's chat is the Bot's view.
      ...(waiting && thread.id !== owner.mainThreadId ? { thread: thread.id } : {}),
      ...await botIdentity(owner),
      timestamp: Date.parse(thread.updatedAt ?? "") || Date.now(),
      kind,
    });
    log(`push: ${kind} ${owner.slug}`);
  }

  /** A routine run ended in a provider failure; only an explicit per-routine choice speaks up. */
  async function notifyFailed(thread: ShellThread) {
    if (!routines || !routineCandidate(thread)) return;
    const bound = boundTasks(thread);
    let wanted = false;
    for (const task of bound) {
      const record = await routines.alerts(task.id).catch(() => null);
      if (effectiveAlerts(record, "own").failed) { wanted = true; break; }
    }
    if (!wanted) for (const task of routineTasks.filter((task) => taskMode(task) === "new_thread" && task.projectId === thread.projectId)) {
      const record = await routines.alerts(task.id).catch(() => null);
      if (effectiveAlerts(record, "new").failed) { wanted = true; break; }
    }
    if (!wanted) return;
    const value = preview ? await preview(thread.id, thread.updatedAt ?? null).catch(() => null) : null;
    const routine = await routineFor(thread, value?.routine ?? null);
    if (!routine || !routine.alerts.failed) return;
    await sendRoutine(routine, thread, "failed", value);
  }

  /** The request was answered, here or on another device: close its notification everywhere. */
  async function resolve(thread: ShellThread) {
    const cached = routineThreads.get(thread.id);
    // A restarted process has no tag cache. The run's own message still names the routine, so one
    // focused projection read recovers the exact tag; a manual turn yields no routine and no notice.
    const routine = !cached && routines && routineCandidate(thread) && preview
      ? await preview(thread.id, thread.updatedAt ?? null).catch(() => null).then((value) => routineFor(thread, value?.routine ?? null, true))
      : null;
    const slug = cached?.bot ?? routine?.bot.slug;
    if (!slug) {
      const owner = await ownerFor(thread, true);
      if (!owner) return;
      await resolveNotice(owner, thread);
      return;
    }
    const owner = (await bots()).find((bot) => bot.slug === slug);
    if (!owner) return;
    routineThreads.delete(thread.id);
    await resolveNotice(owner, thread, cached?.title ?? routine?.task.title);
  }

  async function resolveNotice(owner: Bot, thread: ShellThread, routineTitle?: string) {
    await send({
      // An older worker shows this instead of closing it, so it still reads correctly.
      title: routineTitle ? `${owner.name} · ${routineTitle}` : owner.name,
      body: "Answered",
      tag: waitingTag(owner.slug, thread.id),
      url: `/?bot=${encodeURIComponent(owner.slug)}&thread=${encodeURIComponent(thread.id)}`,
      bot: owner.slug,
      ...(thread.id !== owner.mainThreadId ? { thread: thread.id } : {}),
      // The "Answered" a browser may be left with is still this Bot's.
      ...await botIdentity(owner),
      kind: "resolved",
    });
    log(`push: resolved ${owner.slug}`);
  }

  function handle(event: ShellEvent) {
    // A project-only enrichment snapshot (no threads) is not the roster: it must not reset it.
    if (event.kind === "snapshot" && event.resolvedRepositoryIdentityRoots !== undefined && !event.snapshot?.threads?.length) return;
    if (event.kind === "snapshot") {
      // After a reconnect: a request answered during the gap is resolved now. A thread missing from
      // the snapshot may only be omitted, so only one that is present and no longer waits counts.
      for (const thread of event.snapshot?.threads ?? []) {
        const before = typeof thread?.id === "string" ? previous.get(thread.id) : undefined;
        if (before?.pendingRuntimeRequest && !before.archivedAt && (!thread.pendingRuntimeRequest || thread.archivedAt)) inOrder(thread.id, () => resolve(thread));
      }
      previous.clear();
      for (const thread of event.snapshot?.threads ?? []) if (typeof thread?.id === "string") previous.set(thread.id, thread);
      return;
    }
    if (event.kind === "thread.removed" && typeof event.threadId === "string") {
      const before = previous.get(event.threadId);
      previous.delete(event.threadId);
      if (before?.pendingRuntimeRequest && !before.archivedAt) inOrder(before.id, () => resolve(before));
      return;
    }
    if (event.kind !== "thread.updated" || !event.thread || typeof event.thread.id !== "string") return;
    const next = event.thread;
    const before = previous.get(next.id);
    previous.set(next.id, next);
    if (!before) return;
    const archived = event.location === "archive" || !!next.archivedAt;
    // Before the archive and snooze guards: an answered (or archived) request's notice is stale either way.
    if (before.pendingRuntimeRequest && !before.archivedAt && (!next.pendingRuntimeRequest || archived)) {
      inOrder(next.id, () => resolve(next));
    }
    if (archived) return;
    if (next.snoozedUntil && Date.parse(next.snoozedUntil) > now().getTime()) return;
    const wasActive = ACTIVE.has(before.activityRunStatus ?? before.status);
    const nowStatus = next.activityRunStatus ?? next.status;
    if (!before.pendingRuntimeRequest && next.pendingRuntimeRequest) {
      inOrder(next.id, () => notify(next, "waiting"));
    } else if (!sideChat(next) && wasActive && nowStatus === "completed" && !next.pendingRuntimeRequest) {
      inOrder(next.id, () => notify(next, "finished"));
    } else if (!sideChat(next) && wasActive && nowStatus === "failed") {
      inOrder(next.id, () => notifyFailed(next));
    }
  }

  async function run() {
    while (!stopped) {
      try {
        const client = await connect();
        // A reconnect may land on a different T3: until its task snapshot arrives, guessing a
        // routine from the previous one would attribute someone else's run.
        routineTasks = [];
        // The first snapshot of a connection seeds dispatch state; a failure from before this
        // process watched is history, not a fresh alert.
        taskStates.clear();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const wake = () => { if (!settled) { settled = true; resolve(); } };
          const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
          if (routines) {
            // T3 stays the only scheduler. The snapshot is small and only changes on a task edit.
            taskStream = client.stream("scheduledTasks.subscribe", {}, (event) => {
              const tasks = (event as TaskEvent)?.tasks;
              if (!Array.isArray(tasks)) return;
              const nextStates = new Map<string, string>();
              for (const task of tasks) {
                const signature = `${task.lastRunAt ?? ""}:${task.lastRunStatus ?? ""}`;
                const before = taskStates.get(task.id);
                if (before !== undefined && task.lastRunStatus === "failed" && before !== signature) {
                  inOrder(`task:${task.id}`, () => notifyDispatchFailed(task));
                }
                nextStates.set(task.id, signature);
              }
              taskStates.clear();
              for (const [id, signature] of nextStates) taskStates.set(id, signature);
              routineTasks = tasks;
            });
            // If this half of the connection ends, the map is stale immediately. Reconnect both
            // streams: an alert attributed from the old snapshot could name the wrong routine.
            taskStream.done.then(() => {
              routineTasks = [];
              if (!stopped) log("push: T3 task stream ended; reconnecting");
              try { stream?.cancel(); } catch {}
              wake();
            }, (error) => {
              routineTasks = [];
              if (!stopped) log(`push: T3 task stream ended: ${(error as Error).message}`);
              try { stream?.cancel(); } catch {}
              fail(error);
            });
          }
          stream = client.stream("orchestration.subscribeShell", { omitIdleSubagents: true }, (event) => handle(event as ShellEvent));
          stream.done.then(wake, fail);
        });
      } catch (error) {
        if (!stopped) log(`push: T3 shell stream ended: ${(error as Error).message}`);
      } finally {
        stream = null;
        try { taskStream?.cancel(); } catch {}
        taskStream = null;
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, retryMs);
        timer.unref?.();
      });
    }
  }

  return {
    start() {
      if (!started) started = run();
      return started;
    },
    stop() {
      stopped = true;
      try { stream?.cancel(); } catch {}
      try { taskStream?.cancel(); } catch {}
      if (timer) clearTimeout(timer);
    },
  };
}
