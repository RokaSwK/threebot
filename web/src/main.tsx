import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import "./threebot.css";
import { ensurePushSubscription } from "./lib/push";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && window.isSecureContext && !import.meta.env.DEV) {
  // Android resumes installed apps without a new page load, so check on every return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {});
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: "none" })
      .then(() => ensurePushSubscription())
      .catch(() => {});
  });
}
