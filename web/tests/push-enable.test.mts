import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// enablePushNotifications in a page that has Notification but no Push API, like the Mac app's web view.
const globals = globalThis as Record<string, unknown>;
const saved = { window: globals.window, Notification: globals.Notification, navigator: globals.navigator, fetch: globals.fetch, localStorage: globals.localStorage };
afterEach(() => { for (const [key, value] of Object.entries(saved)) Object.defineProperty(globals, key, { value, configurable: true, writable: true }); });
const define = (key: string, value: unknown) => Object.defineProperty(globals, key, { value, configurable: true, writable: true });

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) };
}

/** A browser with one push subscription; `log` records the order of gateway calls and unsubscribes. */
function pushBrowser(gateway: (url: string) => Response, subscribing: Promise<void> = Promise.resolve()) {
  const log: string[] = [];
  let subscription: { endpoint: string; options: object; unsubscribe(): Promise<boolean>; toJSON(): object } | null = null;
  const make = () => ({ endpoint: "https://fcm.googleapis.com/wp/device", options: {}, async unsubscribe() { log.push("browser unsubscribe"); subscription = null; return true; }, toJSON() { return { endpoint: this.endpoint, keys: {} }; } });
  subscription = make();
  const registration = { pushManager: { async getSubscription() { return subscription; }, async subscribe() { await subscribing; log.push("browser subscribe"); subscription = make(); return subscription; } } };
  define("window", { PushManager: class {} });
  define("Notification", fakeNotification("granted", "granted"));
  define("localStorage", memoryStorage());
  define("navigator", { serviceWorker: { ready: Promise.resolve(registration), async getRegistration() { return registration; } } });
  define("fetch", async (url: string) => { log.push(`gateway ${url}`); return gateway(url); });
  return { log, get subscription() { return subscription; } };
}

function fakeNotification(permission: NotificationPermission, answer: NotificationPermission) {
  return { permission, requestPermission: async () => answer };
}

const { disablePushNotifications, enablePushNotifications, ensurePushSubscription, pushDeviceStatus, pushTurnedOff } = await import("../src/lib/push.ts");

test("granted permission counts as enabled when the Push API is missing", async () => {
  globals.window = {};
  globals.Notification = fakeNotification("default", "granted");
  assert.equal((await enablePushNotifications()).ok, true);
  globals.Notification = fakeNotification("granted", "granted");
  assert.equal((await enablePushNotifications()).ok, true);
});

test("refused or denied permission stays not enabled without the Push API", async () => {
  globals.window = {};
  globals.Notification = fakeNotification("default", "denied");
  const refused = await enablePushNotifications();
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? "", /not granted/i);
  globals.Notification = fakeNotification("denied", "granted");
  const blocked = await enablePushNotifications();
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? "", /blocked/i);
});

test("with the Push API, enabling still needs a working subscription", async () => {
  globals.window = { PushManager: class {} };
  globals.Notification = fakeNotification("granted", "granted");
  // No service worker in this test, so the subscription cannot be made.
  const result = await enablePushNotifications();
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /cannot receive push/i);
});

test("pushDeviceStatus reflects current browser permission and subscription support", async () => {
  globals.window = {};
  globals.Notification = { permission: "denied" };
  const deniedStatus = await pushDeviceStatus();
  assert.equal(deniedStatus.supported, false);
  assert.equal(deniedStatus.permission, "denied");
  assert.equal(deniedStatus.subscribed, false);
});

test("turning push off tells the gateway first, and a failed request keeps the subscription to retry", async () => {
  let fail = true;
  const browser = pushBrowser((url) => url === "/api/push/key" ? Response.json({ publicKey: "AQAB" }) : new Response("{}", { status: fail ? 502 : 200 }));
  const failed = await disablePushNotifications();
  assert.equal(failed.ok, false);
  assert.deepEqual(browser.log, ["gateway /api/push/unsubscribe"], "the browser keeps its subscription");
  assert.ok(browser.subscription);
  assert.equal((await pushDeviceStatus()).subscribed, true);
  fail = false;
  assert.equal((await disablePushNotifications()).ok, true);
  assert.deepEqual(browser.log.slice(1), ["gateway /api/push/unsubscribe", "browser unsubscribe"]);
  assert.equal((await pushDeviceStatus()).subscribed, false);
});

test("push stays off across a reload until Settings turns it on again", async () => {
  const browser = pushBrowser((url) => url === "/api/push/key" ? Response.json({ publicKey: "AQAB" }) : Response.json({ ok: true }));
  assert.equal((await disablePushNotifications()).ok, true);
  browser.log.length = 0;
  // What main.tsx runs on every load while the browser's permission is still granted.
  const quiet = await ensurePushSubscription();
  assert.equal(quiet.ok, false);
  assert.deepEqual(browser.log, [], "no new subscription is made or sent");
  assert.equal(pushTurnedOff(), true);
  assert.equal((await enablePushNotifications()).ok, true);
  assert.equal(pushTurnedOff(), false);
  assert.deepEqual(browser.log, ["gateway /api/push/key", "browser subscribe", "gateway /api/push/subscribe"]);
});

test("a subscription already in flight when push is turned off never reaches the gateway", async () => {
  let release!: () => void;
  const browser = pushBrowser((url) => url === "/api/push/key" ? Response.json({ publicKey: "AQAB" }) : Response.json({ ok: true }), new Promise<void>((resolve) => { release = resolve; }));
  await browser.subscription!.unsubscribe();
  browser.log.length = 0;
  const refresh = ensurePushSubscription();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const off = disablePushNotifications();
  release();
  assert.equal((await refresh).ok, false);
  assert.equal((await off).ok, true);
  assert.equal(browser.log.includes("gateway /api/push/subscribe"), false, `log: ${browser.log.join(", ")}`);
});
