import { useEffect, useState } from "react";
import { Check, Plug } from "lucide-react";
import { executorApi, executorConnectionConfirmed } from "../lib/executor";
import { openDialog, useApp } from "../store";

type Summary = { text: string; action: string; confirmed: boolean };

/** Historical cards re-read real state after management closes and on return. */
export function ExecutorConnectCard({ url, name }: { url: string; name: string }) {
  const dialogOpen = useApp((state) => state.dialog !== null);
  const [summary, setSummary] = useState<Summary>({ text: "Checking connection…", action: "Open", confirmed: false });
  useEffect(() => {
    if (dialogOpen) return;
    let current: AbortController | null = null;
    const refresh = async () => {
      current?.abort();
      const request = new AbortController(); current = request;
      try {
        const result = await executorApi.resolve(url, request.signal);
        let next: Summary;
        if (result.kind === "connection") {
          const app = await executorApi.app(result.connection.appId, request.signal);
          const confirmed = executorConnectionConfirmed(result.connection, app);
          const text = confirmed ? "Account connected" : result.connection.status === "pending" ? "Sign-in pending" : result.connection.status === "expired" ? "Sign-in expired" : result.connection.status === "cancelled" ? "Sign-in cancelled" : "Check the account link";
          next = { text, action: confirmed ? "Manage" : result.connection.status === "pending" ? "Continue" : "Open", confirmed };
        } else if (result.kind === "app") {
          const ready = result.app.status === "connected" || result.app.status === "ready";
          next = { text: result.app.status === "connected" ? "Account connected" : result.app.status === "ready" ? "App ready" : result.app.status === "unknown" ? "Check connection" : "Sign in to connect it", action: ready ? "Manage" : "Connect", confirmed: ready };
        } else next = { text: "Manage connected apps", action: "Open", confirmed: false };
        if (!request.signal.aborted) setSummary(next);
      } catch { if (!request.signal.aborted) setSummary({ text: "Check connection", action: "Open", confirmed: false }); }
    };
    const focus = () => { void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") focus(); };
    focus(); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { current?.abort(); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [url, dialogOpen]);
  return <button type="button" onClick={() => openDialog({ kind: "connect-apps", url })} aria-label={`${name}: ${summary.text}`} className="my-1 flex w-full max-w-[340px] items-center gap-3 rounded-2xl border border-line bg-elevated px-3 py-2.5 text-left hover:bg-hover">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-card">{summary.confirmed ? <Check size={16} className="text-success" /> : <Plug size={16} />}</span>
    <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{name}</span><span className="block truncate text-[12px] text-muted">{summary.text}</span></span>
    <span className="rounded-full bg-pill px-3 py-1 text-[12.5px] font-medium text-pill-fg">{summary.action}</span>
  </button>;
}
