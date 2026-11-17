import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import "./threebot.css";
import { ensurePushSubscription, startPushPresence } from "./lib/push";
import { useApp, watchedView } from "./store";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && window.isSecureContext && !import.meta.env.DEV) {
  let controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const next = navigator.serviceWorker.controller;
    // An older worker may take over on rollback without reloading this document.
    if (controller && next && controller !== next) window.setTimeout(() => window.location.reload(), 1500);
    controller = next;
  });
  // Android resumes installed apps without a new page load, so check on every return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {});
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: "none" })
      .then(() => ensurePushSubscription())
      .catch(() => {});
  });
  startPushPresence(watchedView, (listener) => useApp.subscribe(listener));
}
