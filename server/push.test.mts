import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateVAPIDKeys, WebPushError } from "web-push";
import { createPushNotifier, createPushStore, pushTopic, usableSubject, type PushPreview } from "./push.mts";

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
  assert.equal(await store.devices(), 1);
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
  assert.equal(await gone.devices(), 0);
});

test("each push carries an RFC 8030 topic: the tag when it fits, a hash otherwise", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const topics: Array<string | undefined> = [];
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async (_subscription, _payload, options) => { topics.push(options?.topic); },
  });
  assert.equal((await store.subscribe(subscription)).ok, true);
  await store.send({ title: "Bot", body: "Finished", tag: "alpha", url: "/?bot=alpha", bot: "alpha" });
  await store.send({ title: "Bot", body: "Waiting", tag: "waiting:alpha:thread-1", url: "/?bot=alpha&thread=thread-1", bot: "alpha" });
  assert.equal(topics[0], "alpha");
  assert.equal(topics[1], pushTopic("waiting:alpha:thread-1"));
  assert.match(topics[1]!, /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(pushTopic("a".repeat(40)).length, 32);
  assert.equal(pushTopic("a".repeat(40)), pushTopic("a".repeat(40)));
});

test("a targeted send reaches only the endpoint that asked", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const delivered: string[] = [];
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async (target) => { delivered.push(target.endpoint); },
  });
  const other = { ...subscription, endpoint: "https://fcm.googleapis.com/wp/other" };
  assert.equal((await store.subscribe(subscription)).ok, true);
  assert.equal((await store.subscribe(other)).ok, true);
  const payload = { title: "Threebot", body: "Test notification", tag: "test:notification", url: "/" };
  assert.equal((await store.send(payload, { endpoint: subscription.endpoint })).sent, 1);
  assert.deepEqual(delivered, [subscription.endpoint]);
  assert.equal((await store.send(payload, { endpoint: "https://fcm.googleapis.com/wp/missing" })).sent, 0);
  assert.deepEqual(delivered, [subscription.endpoint]);
  assert.equal((await store.send(payload)).sent, 2);
  assert.deepEqual(delivered, [subscription.endpoint, subscription.endpoint, other.endpoint]);
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
  assert.equal(sent[0].tag, "alpha");
  assert.equal(sent[0].icon, "/api/bots/alpha/avatar.png");
  assert.equal(sent[0].badge, "/api/bots/alpha/badge.png");
  assert.equal(typeof sent[0].timestamp, "number");
  assert.equal(sent[1].tag, "waiting:alpha:thread-1");
  assert.equal(sent[1].url, "/?bot=alpha&thread=thread-1");
  assert.equal(sent[1].kind, "waiting");
  // Answered (here or on another device): every device closes that conversation's notice.
  handler!({ kind: "thread.updated", thread: { id: "thread-1", projectId: "project", status: "running", activityRunStatus: "running", pendingRuntimeRequest: null } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3);
  assert.equal(sent[2].kind, "resolved");
  assert.equal(sent[2].tag, sent[1].tag, "the same tag, and so the same push topic, as the waiting notice");
  notifier.stop();
  assert.equal(cancelled, true);
});

test("a resolved push skips Safari, and asks Firefox to leave a quiet notice", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const delivered: Array<{ endpoint: string; urgency?: string; topic?: string; show?: boolean }> = [];
  const store = createPushStore({ file, generateKeys: () => keys, sender: async (target, payload, options) => { delivered.push({ endpoint: target.endpoint, urgency: options?.urgency, topic: options?.topic, show: JSON.parse(payload).show }); } });
  const apple = { ...subscription, endpoint: "https://web.push.apple.com/device" };
  const mozilla = { ...subscription, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/device" };
  for (const item of [subscription, apple, mozilla]) assert.equal((await store.subscribe(item)).ok, true);
  const tag = "waiting:alpha:thread-1";
  assert.equal((await store.send({ title: "Alpha", body: "Waiting for you", tag, url: "/", bot: "alpha", kind: "waiting" })).sent, 3);
  delivered.length = 0;
  assert.equal((await store.send({ title: "Alpha", body: "Answered", tag, url: "/", bot: "alpha", kind: "resolved" })).sent, 2);
  assert.deepEqual(delivered, [
    { endpoint: subscription.endpoint, urgency: "normal", topic: pushTopic(tag), show: undefined },
    { endpoint: mozilla.endpoint, urgency: "normal", topic: pushTopic(tag), show: true },
  ]);
  assert.equal(await store.devices(), 3, "skipped devices keep their subscription");
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

test("a room push is held back on the device that has that room open", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const sent: string[] = [];
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async (target) => { sent.push(target.endpoint); },
  });
  await store.subscribe(subscription);
  await store.subscribe(second);
  const roomPush = (room: string) => ({
    title: "#Design review",
    body: "Max answered",
    tag: `/?room=${room}`,
    url: `/?room=${room}`,
    room,
  });

  assert.deepEqual(await store.presence(subscription.endpoint, null, "room-1"), { ok: true, watching: true });
  assert.deepEqual(await store.send(roomPush("room-1")), { sent: 1, removed: 0, watching: 1 });
  assert.deepEqual(sent.splice(0), [second.endpoint]);
  // Another room, and a Bot, still reach the device that is looking at room-1.
  assert.equal((await store.send(roomPush("room-2"))).sent, 2);
  sent.length = 0;
  assert.equal((await store.send(payload("alpha"))).sent, 2);
  sent.length = 0;

  // Saying it is looking at a Bot, or at nothing, moves the claim off the room.
  await store.presence(subscription.endpoint, "alpha", null);
  assert.equal((await store.send(roomPush("room-1"))).sent, 2);
  await store.presence(subscription.endpoint, null, null);
  assert.equal((await store.send(roomPush("room-1"))).sent, 2);
  sent.length = 0;

  // Switching from a Bot to a room moves the claim the other way: the Bot's push gets through.
  await store.presence(subscription.endpoint, "alpha", null);
  await store.presence(subscription.endpoint, null, "room-1");
  assert.equal((await store.send(payload("alpha"))).sent, 2);
  assert.deepEqual(await store.send(roomPush("room-1")), { sent: 1, removed: 0, watching: 1 });
});

test("a malformed presence report is refused and leaves the claim alone", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const store = createPushStore({ file, generateKeys: () => keys, sender: async () => {} });
  await store.subscribe(subscription);
  // An older page sends only the Bot, and the page's archived references are Bot references too.
  assert.deepEqual(await store.presence(subscription.endpoint, "archived:2f3c-9a"), { ok: true, watching: true });
  assert.deepEqual(await store.presence(subscription.endpoint, "alpha"), { ok: true, watching: true });
  for (const [bot, room] of [[42, null], [{}, null], ["a".repeat(201), null], ["../alpha", null], [null, 7], [null, "room/1"], ["alpha", "x".repeat(65)]]) {
    assert.equal((await store.presence(subscription.endpoint, bot, room)).ok, false, JSON.stringify([bot, room]));
  }
  assert.equal((await store.send(payload("alpha"))).watching, 1);
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

test("an endpoint unsubscribed while a send is in flight stays removed", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const other = { ...subscription, endpoint: "https://push.example/sub/2" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async (target) => {
      if (target.endpoint === subscription.endpoint) { await gate; return; }
      throw new WebPushError("gone", 410, {}, "", target.endpoint);
    },
  });
  assert.equal((await store.subscribe(subscription)).ok, true);
  assert.equal((await store.subscribe(other)).ok, true);
  const sending = store.send({ title: "Bot", body: "Waiting", tag: "bot", url: "/", bot: "bot" });
  await new Promise((resolve) => setImmediate(resolve));
  await store.unsubscribe(subscription.endpoint);
  release();
  assert.equal((await sending).removed, 1);
  assert.equal(await store.devices(), 0, "neither the gone endpoint nor the unsubscribed one comes back");
  const reloaded = createPushStore({ file, generateKeys: () => keys, sender: async () => {} });
  assert.equal(await reloaded.devices(), 0, "and that is what was saved");
});

test("a muted Bot's request still resolves, and a reconnect resolves what was answered in the gap", async () => {
  let handler: any = null;
  const client = { stream(_tag: string, _payload: unknown, onItem: (event: any) => void) { handler = onItem; return { done: new Promise<void>(() => {}), cancel() {} }; } };
  const bot = { slug: "alpha", name: "Alpha", projectId: "project", mainThreadId: "thread-1", notifications: true, hidden: false };
  const sent: any[] = [];
  const notifier = createPushNotifier({ connect: async () => client as any, bots: async () => [bot as any], send: async (payload) => { sent.push(payload); }, retryMs: 60_000, log: () => {} });
  void notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  const side = (id: string, pending: boolean) => ({ id, projectId: "project", status: pending ? "waiting" : "running", pendingRuntimeRequest: pending ? { id: `r-${id}` } : null, lineage: { parentThreadId: "thread-1", sideChat: true } });
  handler!({ kind: "snapshot", snapshot: { threads: [side("side-1", false), side("side-2", false)] } });
  handler!({ kind: "thread.updated", thread: side("side-1", true) });
  handler!({ kind: "thread.updated", thread: side("side-2", true) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent.map((p) => [p.kind, p.tag]), [["waiting", "waiting:alpha:side-1"], ["waiting", "waiting:alpha:side-2"]]);
  bot.notifications = false;
  handler!({ kind: "thread.updated", thread: side("side-1", false) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent.at(-1).kind === "resolved" && sent.at(-1).tag, "waiting:alpha:side-1", "muting the Bot later does not strand its notice");
  // The stream drops; side chat 2 is answered meanwhile; the new snapshot says so.
  handler!({ kind: "snapshot", snapshot: { threads: [side("side-2", false)] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([sent.at(-1).kind, sent.at(-1).tag], ["resolved", "waiting:alpha:side-2"]);
  assert.equal(sent.length, 4);
  notifier.stop();
});

test("a device that registers again during a send still gets it, and a late 410 removes only the old record", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "threebot-push-")), "push.json");
  const other = { ...subscription, endpoint: "https://push.example/sub/2" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delivered: string[] = [];
  let first = true;
  const store = createPushStore({
    file,
    generateKeys: () => keys,
    sender: async (target) => {
      if (target.endpoint === other.endpoint && first) { first = false; await gate; throw new WebPushError("gone", 410, {}, "", target.endpoint); }
      delivered.push(target.endpoint);
    },
  });
  assert.equal((await store.subscribe(other)).ok, true);
  assert.equal((await store.subscribe(subscription)).ok, true);
  const sending = store.send({ title: "Bot", body: "Waiting", tag: "bot", url: "/", bot: "bot" });
  await new Promise((resolve) => setImmediate(resolve));
  // Both devices register again while the first send is still waiting on the push service.
  assert.equal((await store.subscribe(other)).ok, true);
  assert.equal((await store.subscribe(subscription)).ok, true);
  release();
  await sending;
  assert.ok(delivered.includes(subscription.endpoint), "the re-registered device still receives the push");
  assert.equal(await store.devices(), 2, "the fresh registration of the failed endpoint is kept");
});

test("a removed thread that was waiting resolves its notice", async () => {
  let handler: any = null;
  const client = { stream(_tag: string, _payload: unknown, onItem: (event: any) => void) { handler = onItem; return { done: new Promise<void>(() => {}), cancel() {} }; } };
  const bot = { slug: "alpha", name: "Alpha", projectId: "project", mainThreadId: "thread-1", notifications: true, hidden: false };
  const sent: any[] = [];
  const notifier = createPushNotifier({ connect: async () => client as any, bots: async () => [bot as any], send: async (payload) => { sent.push(payload); }, retryMs: 60_000, log: () => {} });
  void notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  const side = { id: "side-1", projectId: "project", status: "waiting", pendingRuntimeRequest: { id: "r" }, lineage: { parentThreadId: "thread-1", sideChat: true } };
  handler!({ kind: "snapshot", snapshot: { threads: [side] } });
  handler!({ kind: "thread.removed", threadId: "side-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent.map((p) => [p.kind, p.tag]), [["resolved", "waiting:alpha:side-1"]]);
  notifier.stop();
});
