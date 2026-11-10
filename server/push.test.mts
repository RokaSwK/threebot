import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateVAPIDKeys, WebPushError } from "web-push";
import { createPushNotifier, createPushStore } from "./push.mts";

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
