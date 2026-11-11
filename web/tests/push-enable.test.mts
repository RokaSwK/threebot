import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// enablePushNotifications in a page that has Notification but no Push API, like the Mac app's web view.
const globals = globalThis as Record<string, unknown>;
const saved = { window: globals.window, Notification: globals.Notification };
afterEach(() => Object.assign(globals, saved));

function fakeNotification(permission: NotificationPermission, answer: NotificationPermission) {
  return { permission, requestPermission: async () => answer };
}

const { enablePushNotifications } = await import("../src/lib/push.ts");

test("granted permission counts as enabled when the Push API is missing", async () => {
  globals.window = {};
  globals.Notification = fakeNotification("default", "granted");
  assert.equal(await enablePushNotifications(), true);
  globals.Notification = fakeNotification("granted", "granted");
  assert.equal(await enablePushNotifications(), true);
});

test("refused or denied permission stays not enabled without the Push API", async () => {
  globals.window = {};
  globals.Notification = fakeNotification("default", "denied");
  assert.equal(await enablePushNotifications(), false);
  globals.Notification = fakeNotification("denied", "granted");
  assert.equal(await enablePushNotifications(), false);
});

test("with the Push API, enabling still needs a working subscription", async () => {
  globals.window = { PushManager: class {} };
  globals.Notification = fakeNotification("granted", "granted");
  // No service worker in this test, so the subscription cannot be made.
  assert.equal(await enablePushNotifications(), false);
});
