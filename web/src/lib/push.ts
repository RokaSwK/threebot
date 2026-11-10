// Browser side of Web Push. The service worker shows the notification when the app is closed;
// when the app is open, the page's own notification logic remains in charge.
function keyBytes(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
}

let pending: Promise<boolean> | null = null;
// Set by startPushPresence: says again which Bot this device is looking at.
let resendPresence = () => {};

/** Subscribe this browser to push when permission is already granted. Safe to call often. */
export function ensurePushSubscription(): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const response = await fetch("/api/push/key", { cache: "no-store" });
      if (!response.ok) return false;
      const { publicKey } = await response.json() as { publicKey?: unknown };
      if (typeof publicKey !== "string" || !publicKey) return false;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
    }
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    // The gateway only now knows this device, so anything said before this was not heard.
    if (response.ok) resendPresence();
    return response.ok;
  })().catch(() => false).finally(() => { pending = null; });
  return pending;
}

// How often a device repeats which Bot it is looking at. The gateway forgets the claim after 30 s
// (WATCHING_MS in server/push.mts), so one lost report doesn't let a push through.
const PRESENCE_MS = 12_000;

/**
 * Keep the gateway told which Bot this device has open and in focus (null when it looks away), so
 * it doesn't push what is already on screen. `watching` is the page's own "the user is looking at
 * this Bot" rule; `onChange` subscribes to whatever can change its answer besides focus.
 */
export function startPushPresence(watching: () => string | null, onChange: (listener: () => void) => void): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  // undefined: nothing has reached the gateway yet.
  let reported: string | null | undefined;
  let reportedAt = 0;
  const sync = () => {
    const bot = watching();
    if (bot === reported && (bot === null || Date.now() - reportedAt < PRESENCE_MS)) return;
    if (bot === null && reported === undefined) return;
    reported = bot;
    reportedAt = Date.now();
    void (async () => {
      const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      if (!subscription) return;
      // keepalive lets the "looked away" report finish while the page is being hidden or closed.
      await fetch("/api/push/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint, bot }),
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
export function enablePushNotifications(): Promise<boolean> {
  if (typeof Notification === "undefined") return Promise.resolve(false);
  if (Notification.permission === "granted") return ensurePushSubscription();
  if (Notification.permission === "denied") return Promise.resolve(false);
  return Notification.requestPermission()
    .then((permission) => permission === "granted" ? ensurePushSubscription() : false)
    .catch(() => false);
}
