// Served at https://bot.swk.tools/sw.js by the landing workflow, never by the app.
// bot.swk.tools used to be a real Threebot, whose service worker kept serving its cached app shell
// (and a Cloudflare Access sign-in) in place of the landing. When a browser checks that old worker
// for an update it gets this one, which clears the caches, unregisters itself and reloads its pages.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim().catch(() => {});
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      client.navigate(client.url).catch(() => {});
    }
  })());
});
