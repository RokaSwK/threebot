// Browser side of Web Push. The service worker shows the notification when the app is closed;
// when the app is open, the page's own notification logic remains in charge.
function keyBytes(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
}

/** What a subscription attempt produced, so the Settings panel can say why it failed. */
export type PushResult = { ok: boolean; reason?: string };

export type PushDeviceStatus = {
  supported: boolean;
  /** Web Push needs HTTPS; a plain-HTTP page cannot subscribe even when the API exists. */
  secure: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  /** This browser's subscription endpoint, so the Settings test reaches this device only. */
  endpoint?: string;
  endpointHost?: string;
};

let pending: Promise<PushResult> | null = null;
// Set by startPushPresence: says again what this device is looking at.
let resendPresence = () => {};

/** A subscription made for another server key cannot receive this gateway's pushes. */
function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options?.applicationServerKey;
  if (!key) return true;
  const a = new Uint8Array(key);
  const b = new Uint8Array(keyBytes(publicKey));
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.name && error.message ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

/** Subscribe this browser to push when permission is already granted. Safe to call often. */
export function ensurePushSubscription(): Promise<PushResult> {
  if (pending) return pending;
  pending = (async (): Promise<PushResult> => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return { ok: false, reason: "This browser cannot receive push notifications." };
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return { ok: false, reason: "Notification permission is not granted." };
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const response = await fetch("/api/push/key", { cache: "no-store" });
      if (!response.ok) return { ok: false, reason: `The gateway did not provide a push key (HTTP ${response.status}).` };
      const { publicKey } = await response.json() as { publicKey?: unknown };
      if (typeof publicKey !== "string" || !publicKey) return { ok: false, reason: "The gateway returned an empty push key." };
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !sameKey(subscription, publicKey)) {
        // The gateway's VAPID key changed: the old endpoint is useless here.
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      const saved = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      if (!saved.ok) {
        const body = await saved.json().catch(() => null) as { error?: unknown } | null;
        return { ok: false, reason: typeof body?.error === "string" ? body.error : `The gateway refused the subscription (HTTP ${saved.status}).` };
      }
      // The gateway only now knows this device, so anything said before this was not heard.
      resendPresence();
      return { ok: true };
    } catch (error) {
      console.error("[push] subscription failed", error);
      return { ok: false, reason: reason(error) };
    }
  })().finally(() => { pending = null; });
  return pending;
}

/** What this browser can do right now: permission, support and whether it has a subscription. */
export async function pushDeviceStatus(): Promise<PushDeviceStatus> {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  const permission: PushDeviceStatus["permission"] = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  let subscribed = false;
  let endpoint: string | undefined;
  let endpointHost: string | undefined;
  if (supported) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      subscribed = Boolean(subscription);
      if (subscription) {
        endpoint = subscription.endpoint;
        try { endpointHost = new URL(subscription.endpoint).host; } catch { /* A malformed endpoint still counts as subscribed. */ }
      }
    } catch { /* A registration that cannot be read means no usable subscription yet. */ }
  }
  return { supported, secure: typeof isSecureContext === "boolean" ? isSecureContext : true, permission, subscribed, endpoint, endpointHost };
}

/** Remove this browser's subscription locally and from the gateway. */
export async function disablePushNotifications(): Promise<PushResult> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return { ok: true };
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return { ok: true };
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    const response = await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    if (!response.ok) return { ok: false, reason: `The gateway could not remove the subscription (HTTP ${response.status}).` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
}

// How often a device repeats what it is looking at. The gateway forgets the claim after 30 s
// (WATCHING_MS in server/push.mts), so one lost report doesn't let a push through.
const PRESENCE_MS = 12_000;

/** The room or the Bot's conversation this page has open, or nothing when it looks away. */
export type PushView = { bot: string | null; room: string | null };

/**
 * Keep the gateway told which Bot's conversation or which room this device has open and in focus
 * (nothing when it looks away), so it doesn't push what is already on screen. `watching` is the
 * page's own "the user is looking at this" rule; `onChange` subscribes to whatever can change its
 * answer besides focus.
 */
export function startPushPresence(watching: () => PushView, onChange: (listener: () => void) => void): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  // undefined: nothing has reached the gateway yet.
  let reported: string | undefined;
  let reportedAt = 0;
  const sync = () => {
    const { bot, room } = watching();
    const key = room ? `room:${room}` : bot ? `bot:${bot}` : "";
    if (key === reported && (!key || Date.now() - reportedAt < PRESENCE_MS)) return;
    if (!key && reported === undefined) return;
    reported = key;
    reportedAt = Date.now();
    void (async () => {
      const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      if (!subscription) return;
      // keepalive lets the "looked away" report finish while the page is being hidden or closed.
      await fetch("/api/push/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint, bot, room }),
        keepalive: true,
      });
    })().catch(() => {});
  };
  resendPresence = () => {
    reported = undefined;
    sync();
  };
  onChange(sync);
  for (const type of ["focus", "blur", "pagehide", "pageshow"]) window.addEventListener(type, sync);
  document.addEventListener("visibilitychange", sync);
  setInterval(sync, PRESENCE_MS);
  sync();
}

/** Ask for notification permission and, if granted, register the push subscription. */
export function enablePushNotifications(): Promise<PushResult> {
  if (typeof Notification === "undefined") return Promise.resolve({ ok: false, reason: "Notifications are not available in this app." });
  // Without the Push API (the Mac app's web view), granted permission still turns on the page's own
  // notifications, so it counts as enabled.
  const subscribe = () => "PushManager" in window ? ensurePushSubscription() : Promise.resolve<PushResult>({ ok: true });
  if (Notification.permission === "granted") return subscribe();
  if (Notification.permission === "denied") {
    return Promise.resolve({ ok: false, reason: "Notifications are blocked for this site. Allow them in the browser's site settings and try again." });
  }
  return Notification.requestPermission()
    .then((permission) => permission === "granted" ? subscribe() : { ok: false, reason: "Notification permission was not granted." })
    .catch(() => ({ ok: false, reason: "The browser could not ask for notification permission." }));
}
