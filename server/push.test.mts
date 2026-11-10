import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateVAPIDKeys, WebPushError } from "web-push";
import { createPushNotifier, createPushStore, usableSubject, type PushPreview } from "./push.mts";

const keys = generateVAPIDKeys();
const subscription = {
  endpoint: "https://push.example/sub/1",
  keys: { p256dh: "p256dh-value-1234567890", auth: "auth-value-1234" },
};

test("push subscriptions dedupe, unsubscribe and remove a gone endpoint", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const sent: string[] = [];
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async (_subscription, payload) => { sent.push(payload); },
  });
  assert.equal(await store.publicKey(), keys.publicKey);
  assert.equal((await store.subscribe(subscription)).ok, true);
  assert.equal((await store.subscribe(subscription)).ok, true);
  assert.equal((await store.subscribe({ endpoint: "not a url", keys: subscription.keys })).ok, false);
  const result = await store.send({ title: "Bot", body: "Finished", tag: "bot", url: "/?bot=bot", bot: "bot" });
  assert.equal(result.sent, 1);
  assert.match(sent[0]!, /"body":"Finished"/u);

  const gone = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async () => { throw new WebPushError("gone", 410, {} as any, "", subscription.endpoint); },
  });
  await gone.subscribe(subscription);
  const removed = await gone.send({ title: "Bot", body: "Finished", tag: "bot", url: "/", bot: "bot" });
  assert.equal(removed.removed, 1);
  assert.equal((await gone.unsubscribe(subscription.endpoint)).subscriptions, 0);
});

test("the notifier ignores the first snapshot and pushes completions and requests", async () => {
  let handler: any = null;
  let cancelled = false;
  const client = {
    stream(_tag: string, _payload: unknown, onItem: (event: any) => void) {
      handler = onItem;
      return { done: new Promise<void>(() => {}), cancel: () => { cancelled = true; } };
    },
  };
  const bot = { slug: "alpha", name: "Alpha", projectId: "project", mainThreadId: "thread-1", notifications: true, hidden: false };
  const sent: any[] = [];
  const notifier = createPushNotifier({
    connect: async () => client as any,
    bots: async () => [bot as any],
    send: async (payload) => { sent.push(payload); },
    retryMs: 60_000,
    log: () => {},
  });
  void notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handler);
  handler!({ kind: "snapshot", snapshot: { threads: [{ id: "thread-1", projectId: "project", status: "running", activityRunStatus: "running", pendingRuntimeRequest: null }] } });
  handler!({ kind: "thread.updated", thread: { id: "thread-1", projectId: "project", status: "completed", activityRunStatus: "completed", pendingRuntimeRequest: null, updatedAt: "2026-11-10T10:00:00.000Z" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "Finished");
  handler!({ kind: "thread.updated", thread: { id: "thread-1", projectId: "project", status: "waiting", activityRunStatus: "waiting", pendingRuntimeRequest: { id: "request-1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, "Waiting for you");
  notifier.stop();
  assert.equal(cancelled, true);
});

test("disabled Bots and a first thread update do not notify", async () => {
  let handler: any = null;
  const notifier = createPushNotifier({
    connect: async () => ({ stream: (_tag: string, _payload: unknown, onItem: (event: any) => void) => { handler = onItem; return { done: new Promise<void>(() => {}), cancel() {} }; } }) as any,
    bots: async () => [{ slug: "alpha", name: "Alpha", projectId: "project", mainThreadId: "thread-1", notifications: false, hidden: false } as any],
    send: async () => { throw new Error("should not send"); },
    retryMs: 60_000,
    log: () => {},
  });
  void notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  handler!({ kind: "thread.updated", thread: { id: "thread-1", projectId: "project", status: "completed", activityRunStatus: "completed" } });
  handler!({ kind: "snapshot", snapshot: { threads: [] } });
  handler!({ kind: "thread.updated", thread: { id: "thread-1", projectId: "project", status: "completed", activityRunStatus: "completed" } });
  await new Promise((resolve) => setImmediate(resolve));
  notifier.stop();
});

const payload = (bot: string) => ({ title: bot, body: "Finished", tag: bot, url: `/?bot=${bot}`, bot });
const second = { endpoint: "https://push.example/sub/2", keys: subscription.keys };

test("a device that has the Bot open is not sent that Bot's push, until it looks away or goes quiet", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const sent: string[] = [];
  let clock = Date.parse("2026-11-10T10:00:00.000Z");
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    now: () => new Date(clock),
    sender: async (target) => { sent.push(target.endpoint); },
  });
  await store.subscribe(subscription);
  await store.subscribe(second);

  assert.deepEqual(await store.presence(subscription.endpoint, "alpha"), { ok: true, watching: true });
  assert.deepEqual(await store.send(payload("alpha")), { sent: 1, removed: 0, watching: 1 });
  assert.deepEqual(sent.splice(0), [second.endpoint]);
  // Another Bot's push still reaches the device that is watching alpha.
  assert.equal((await store.send(payload("beta"))).sent, 2);
  sent.length = 0;

  // The page went away without saying so: the claim lapses on its own.
  clock += 31_000;
  assert.equal((await store.send(payload("alpha"))).sent, 2);
  sent.length = 0;

  await store.presence(subscription.endpoint, "alpha");
  await store.presence(subscription.endpoint, null);
  assert.equal((await store.send(payload("alpha"))).sent, 2);

  // Only a subscribed device can claim to be watching.
  assert.deepEqual(await store.presence("https://push.example/unknown", "alpha"), { ok: true, watching: false });
});

test("pushes are signed with a contact Apple accepts", async () => {
  assert.equal(usableSubject("mailto:threebot@localhost"), null);
  assert.equal(usableSubject("http://bot.example.com"), null);
  assert.equal(usableSubject("https://localhost:8443"), null);
  assert.equal(usableSubject("https://nas.local"), null);
  assert.equal(usableSubject("https://192.168.1.20"), null);
  assert.equal(usableSubject("mailto: <me@example.com>"), null);
  assert.equal(usableSubject("mailto:me@example.com"), "mailto:me@example.com");
  assert.equal(usableSubject("https://bot.example.com/some/path"), "https://bot.example.com");

  const subjects: (string | undefined)[] = [];
  const make = async (options: { subject?: string; appUrl?: string }) => createPushStore({
    file: path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json"),
    generateKeys: () => keys,
    sender: async (_target, _payload, sendOptions) => { subjects.push(sendOptions?.vapidDetails?.subject); },
    subject: undefined,
    appUrl: undefined,
    ...options,
  });

  // Nothing configured: the address the browser subscribed from, kept across restarts.
  const learned = await make({});
  await learned.subscribe(subscription, "http://localhost:5173");
  await learned.send(payload("alpha"));
  await learned.subscribe(subscription, "https://bot.example.com");
  await learned.send(payload("alpha"));
  assert.deepEqual(subjects.splice(0), ["mailto:threebot@localhost", "https://bot.example.com"]);

  const withAppUrl = await make({ appUrl: "https://app.example.com/" });
  await withAppUrl.subscribe(subscription, "https://bot.example.com");
  await withAppUrl.send(payload("alpha"));
  const configured = await make({ subject: "mailto:owner@example.com", appUrl: "https://app.example.com" });
  await configured.subscribe(subscription, "https://bot.example.com");
  await configured.send(payload("alpha"));
  assert.deepEqual(subjects.splice(0), ["https://app.example.com", "mailto:owner@example.com"]);
});

/** A notifier fed by hand, with one Bot whose main conversation is thread "main". */
async function notifierWith(preview?: (threadId: string, stamp: string | null) => Promise<PushPreview | null>) {
  let handler: (event: any) => void = () => {};
  const sent: any[] = [];
  const notifier = createPushNotifier({
    connect: async () => ({ stream: (_tag: string, _payload: unknown, onItem: (event: any) => void) => { handler = onItem; return { done: new Promise<void>(() => {}), cancel() {} }; } }) as any,
    bots: async () => [{ slug: "alpha", name: "Alpha", projectId: "project", mainThreadId: "main", notifications: true, hidden: false } as any],
    send: async (item) => { sent.push(item); },
    preview,
    retryMs: 60_000,
    log: () => {},
    now: () => new Date("2026-11-10T10:00:00.000Z"),
  });
  void notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const thread = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, projectId: "project", status, activityRunStatus: status, pendingRuntimeRequest: null, lineage: { rootThreadId: id, parentThreadId: null }, ...extra });
  /** Run a thread from running to `status` and report what was pushed. */
  const finish = async (id: string, status: string, extra: Record<string, unknown> = {}) => {
    sent.length = 0;
    handler({ kind: "thread.updated", thread: thread(id, "running", { ...extra, pendingRuntimeRequest: null }) });
    handler({ kind: "thread.updated", thread: thread(id, "running", { ...extra, pendingRuntimeRequest: null }) });
    handler({ kind: "thread.updated", thread: thread(id, status, extra) });
    await settle();
    return sent.map((item) => item.body);
  };
  return { notifier, finish };
}

test("only the main conversation and a waiting side chat push, as on the page", async () => {
  const { notifier, finish } = await notifierWith();
  const child = (extra: Record<string, unknown> = {}) => ({ lineage: { rootThreadId: "main", parentThreadId: "main", ...extra } });

  assert.deepEqual(await finish("main", "completed"), ["Finished"]);
  // A routine's own thread, and a subagent of the main conversation, are in the Bot's project too.
  assert.deepEqual(await finish("routine-thread", "completed"), []);
  assert.deepEqual(await finish("subagent", "completed", child({ relationshipToParent: "subagent" })), []);
  assert.deepEqual(await finish("subagent", "waiting", { ...child({ relationshipToParent: "subagent" }), pendingRuntimeRequest: { id: "r" } }), []);
  // A side chat only speaks up when it needs the user.
  assert.deepEqual(await finish("side", "completed", child({ sideChat: true })), []);
  assert.deepEqual(await finish("side", "waiting", { ...child({ sideChat: true }), pendingRuntimeRequest: { id: "r" } }), ["A side chat is waiting for you"]);
  // Snoozed until later: quiet. A snooze that has passed: back to normal.
  assert.deepEqual(await finish("main", "completed", { snoozedUntil: "2026-11-10T12:00:00.000Z" }), []);
  assert.deepEqual(await finish("main", "completed", { snoozedUntil: "2026-11-10T09:00:00.000Z" }), ["Finished"]);
  notifier.stop();
});

test("a completion push quotes only this run's own reply", async () => {
  let next: PushPreview | null = null;
  const { notifier, finish } = await notifierWith(async () => next);
  const run = { latestRunStartedAt: "2026-11-10T09:59:00.000Z" };

  next = { role: "assistant", text: "  The review is ready.  ", at: "2026-11-10T09:59:30.000Z" };
  assert.deepEqual(await finish("main", "completed", run), ["The review is ready."]);
  // The newest item is the user's own prompt: the run wrote nothing to quote.
  next = { role: "user", text: "Review the PR please", at: "2026-11-10T09:59:30.000Z" };
  assert.deepEqual(await finish("main", "completed", run), ["Finished"]);
  // A reply from before this run started.
  next = { role: "assistant", text: "Yesterday's answer", at: "2026-11-09T18:00:00.000Z" };
  assert.deepEqual(await finish("main", "completed", run), ["Finished"]);
  next = null;
  assert.deepEqual(await finish("main", "completed", run), ["Finished"]);
  notifier.stop();
});
