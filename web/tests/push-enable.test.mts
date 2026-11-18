import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// enablePushNotifications in a page that has Notification but no Push API, like the Mac app's web view.
const globals = globalThis as Record<string, unknown>;
const saved = { window: globals.window, Notification: globals.Notification };
afterEach(() => Object.assign(globals, saved));

function fakeNotification(permission: NotificationPermission, answer: NotificationPermission) {
  return { permission, requestPermission: async () => answer };
}

const { enablePushNotifications, pushDeviceStatus } = await import("../src/lib/push.ts");

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
