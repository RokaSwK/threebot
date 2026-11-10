// Web Push for the installed PWA: VAPID keys and browser subscriptions live in one JSON file,
// and the gateway watches T3's thread shell for finished or waiting Bots. A push only says which
// Bot and a short preview; the actual conversation stays in T3.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateVAPIDKeys, sendNotification, setVapidDetails, WebPushError } from "web-push";
import type { Bot } from "./main-bot.mts";
import type { T3Client } from "./t3rpc.mts";

const MAX_SUBSCRIPTIONS = 20;
const MAX_ENDPOINT = 2_048;

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
};

type PushState = {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
};

export type PushPayload = {
  title: string;
  body: string;
  tag: string;
  url: string;
  bot: string;
};

type Sender = (subscription: PushSubscription, payload: string, options?: { TTL?: number; urgency?: string }) => Promise<unknown>;

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

/** VAPID keys and push subscriptions. The private key never leaves this file or the server. */
export function createPushStore({
  file,
  subject = process.env.VAPID_SUBJECT ?? "mailto:threebot@localhost",
  sender = sendNotification as unknown as Sender,
  generateKeys = generateVAPIDKeys,
  now = () => new Date(),
}: {
  file: string;
  subject?: string;
  sender?: Sender;
  generateKeys?: () => { publicKey: string; privateKey: string };
  now?: () => Date;
}) {
  let state: PushState | null = null;
  let writes = Promise.resolve();

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
    state = { vapid: keys, subscriptions };
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

    async subscribe(value: unknown): Promise<{ ok: true; subscriptions: number } | { ok: false; message: string }> {
      const item = record(value);
      if (!item) return { ok: false, message: "The push subscription is invalid." };
      const current = await load();
      if (!current.subscriptions.some((subscription) => subscription.endpoint === item.endpoint) && current.subscriptions.length >= MAX_SUBSCRIPTIONS) {
        return { ok: false, message: "This install already has the maximum number of push devices." };
      }
      current.subscriptions = [
        ...current.subscriptions.filter((subscription) => subscription.endpoint !== item.endpoint),
        { ...item, createdAt: now().toISOString() },
      ];
      await save();
      return { ok: true, subscriptions: current.subscriptions.length };
    },

    async unsubscribe(endpoint: unknown): Promise<{ ok: true; subscriptions: number }> {
      const current = await load();
      if (typeof endpoint === "string") current.subscriptions = current.subscriptions.filter((subscription) => subscription.endpoint !== endpoint);
      await save();
      return { ok: true, subscriptions: current.subscriptions.length };
    },

    async send(payload: PushPayload): Promise<{ sent: number; removed: number }> {
      const current = await load();
      if (!current.subscriptions.length) return { sent: 0, removed: 0 };
      setVapidDetails(subject, current.vapid.publicKey, current.vapid.privateKey);
      let sent = 0;
      let removed = 0;
      const keep: PushSubscriptionRecord[] = [];
      for (const subscription of current.subscriptions) {
        try {
          await sender(subscription as unknown as PushSubscription, JSON.stringify(payload), { TTL: 3_600, urgency: "high" });
          sent += 1;
          keep.push(subscription);
        } catch (error) {
          const status = error instanceof WebPushError ? error.statusCode : 0;
          if (status === 404 || status === 410) removed += 1;
          else {
            keep.push(subscription);
            console.error("push: send failed", status || (error as Error).message);
          }
        }
      }
      if (removed > 0) {
        current.subscriptions = keep;
        await save();
      }
      return { sent, removed };
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
  lineage?: { rootThreadId?: string | null; parentThreadId?: string | null } | null;
  updatedAt?: string | null;
};

type ShellEvent = {
  kind: string;
  snapshot?: { threads?: ShellThread[] };
  thread?: ShellThread;
  location?: string;
};

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Watch T3's shell stream and turn transitions into pushes. The first snapshot only seeds state;
 * a Bot is notified when a run it was active in reaches completed, or when a request appears.
 */
export function createPushNotifier({
  connect,
  bots,
  send,
  preview,
  retryMs = 5_000,
  log = (line: string) => console.log(line),
}: {
  connect: () => Promise<T3Client>;
  bots: () => Promise<Bot[]>;
  send: (payload: PushPayload) => Promise<unknown>;
  preview?: (threadId: string, stamp: string | null) => Promise<string | null>;
  retryMs?: number;
  log?: (line: string) => void;
}) {
  const previous = new Map<string, ShellThread>();
  let stopped = false;
  let stream: ReturnType<T3Client["stream"]> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started: Promise<void> | null = null;

  async function ownerFor(thread: ShellThread): Promise<Bot | null> {
    const list = await bots();
    return list.find((bot) => !bot.hidden && bot.notifications !== false && (
      bot.mainThreadId === thread.id
      || bot.mainThreadId === thread.lineage?.rootThreadId
      || bot.mainThreadId === thread.lineage?.parentThreadId
      || (Boolean(bot.projectId) && bot.projectId === thread.projectId)
    )) ?? null;
  }

  async function notify(thread: ShellThread, kind: "finished" | "waiting") {
    const owner = await ownerFor(thread);
    if (!owner) return;
    let body = kind === "waiting" ? "Waiting for you" : "Finished";
    if (kind === "finished" && preview) {
      const value = await preview(thread.id, thread.updatedAt ?? null).catch(() => null);
      if (value?.trim()) body = value.trim().slice(0, 140);
    }
    await send({
      title: owner.name,
      body,
      tag: owner.slug,
      url: `/?bot=${encodeURIComponent(owner.slug)}`,
      bot: owner.slug,
    });
    log(`push: ${kind} ${owner.slug}`);
  }

  function handle(event: ShellEvent) {
    if (event.kind === "snapshot") {
      previous.clear();
      for (const thread of event.snapshot?.threads ?? []) if (typeof thread?.id === "string") previous.set(thread.id, thread);
      return;
    }
    if (event.kind !== "thread.updated" || !event.thread || typeof event.thread.id !== "string") return;
    const next = event.thread;
    const before = previous.get(next.id);
    previous.set(next.id, next);
    if (event.location === "archive" || next.archivedAt) return;
    if (!before) return;
    const wasActive = ACTIVE.has(before.activityRunStatus ?? before.status);
    const nowStatus = next.activityRunStatus ?? next.status;
    if (!before.pendingRuntimeRequest && next.pendingRuntimeRequest) {
      void notify(next, "waiting").catch((error) => log(`push: ${(error as Error).message}`));
    } else if (wasActive && nowStatus === "completed" && !next.pendingRuntimeRequest) {
      void notify(next, "finished").catch((error) => log(`push: ${(error as Error).message}`));
    }
  }

  async function run() {
    while (!stopped) {
      try {
        const client = await connect();
        await new Promise<void>((resolve, reject) => {
          stream = client.stream("orchestration.subscribeShell", { omitIdleSubagents: true }, (event) => handle(event as ShellEvent));
          stream.done.then(() => resolve(), (error) => reject(error));
        });
      } catch (error) {
        if (!stopped) log(`push: T3 shell stream ended: ${(error as Error).message}`);
      } finally {
        stream = null;
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
      if (timer) clearTimeout(timer);
    },
  };
}
