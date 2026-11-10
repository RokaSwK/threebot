// Browser side of Web Push. The service worker shows the notification when the app is closed;
// when the app is open, the page's own notification logic remains in charge.
function keyBytes(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
}

let pending: Promise<boolean> | null = null;

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
    return response.ok;
  })().catch(() => false).finally(() => { pending = null; });
  return pending;
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
