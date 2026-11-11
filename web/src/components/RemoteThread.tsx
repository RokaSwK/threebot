// A thread on another machine that Threebot reaches only through T3's link (route "linked"): T3
// forwards tool calls there, not a live connection, so this reads the conversation's messages over
// the gateway every few seconds and sends with t3_thread_send. Machines with a direct route (paired
// in Settings → Machines, or T3_ENVIRONMENTS_FILE) open in the normal live chat instead.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Send } from "lucide-react";
import clsx from "clsx";
import { api, type RemoteItem, type RemoteRead } from "../lib/api";
import { threadTarget } from "../lib/t3";
import type { Bot } from "../lib/types";
import { RichMarkdown } from "./RichMarkdown";
import { MachineBadge } from "./MachineBadge";
import { IconButton, Spinner } from "./ui";
import { machineOf, openDialog, selectThread, useApp } from "../store";

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function RemoteThread({ bot, threadId, onBack }: { bot: Bot; threadId: string; onBack?: () => void }) {
  const target = threadTarget(threadId);
  const environmentId = target.environmentId!;
  const machine = useApp((s) => machineOf(threadId, s.machines));
  const [thread, setThread] = useState<RemoteRead["thread"]>(null);
  const [items, setItems] = useState<RemoteItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const position = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => { position.current = null; setItems([]); setThread(null); setLoaded(false); setError(null); }, [threadId]);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const { read } = await api.remoteThread(environmentId, target.threadId, position.current);
        if (stopped) return;
        setThread(read.thread);
        if (read.items.length) setItems((current) => {
          const byId = new Map(current.map((item) => [item.itemId, item]));
          for (const item of read.items) byId.set(item.itemId, item);
          return [...byId.values()].sort((a, b) => a.position - b.position);
        });
        // Keep the last finished message as the next starting point, so a reply still streaming is read again.
        const settled = read.items.filter((item) => item.status === "completed" || item.type === "user_message").at(-1);
        if (settled) position.current = Math.max(position.current ?? 0, settled.position);
        setError(null);
        setLoaded(true);
        timer = window.setTimeout(poll, read.thread && ACTIVE.has(read.thread.status) ? 4000 : 15000);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : "Couldn't read this thread");
        setLoaded(true);
        timer = window.setTimeout(poll, 20000);
      }
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [environmentId, target.threadId, refresh]);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [items.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try { await api.sendRemote(environmentId, target.threadId, text); setDraft(""); setRefresh((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't send"); }
    finally { setSending(false); }
  };
  const working = !!thread && ACTIVE.has(thread.status);
  const back = () => onBack ? onBack() : selectThread(bot, bot.mainThreadId ?? threadId);

  return (
    <section className="chat-view relative flex h-full min-w-0 flex-1 flex-col bg-chat" data-remote-thread={target.threadId}>
      <header className="chat-header flex h-[52px] shrink-0 items-center justify-center gap-2 px-12">
        <IconButton onClick={back} className="chat-back absolute left-2" aria-label="Back"><ChevronLeft size={24} /></IconButton>
        <span className="min-w-0 truncate text-[13.5px] font-medium">{thread?.title ?? "Thread"}</span>
        <MachineBadge environmentId={environmentId} />
      </header>
      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="mx-auto flex max-w-[760px] flex-col">
          <p className="my-3 rounded-xl border border-line px-3 py-2 text-[12.5px] text-muted">
            Read through T3's link to {machine?.label ?? "another machine"}. Files and pictures from its workspace show once you <button className="underline" onClick={() => { useApp.setState({ settingsPane: "machines" }); openDialog("settings"); }}>pair it directly</button>.
          </p>
          {!loaded && <div role="status" className="grid h-32 place-items-center"><Spinner /></div>}
          {error && <div role="alert" className="my-2 rounded-xl border border-line px-3 py-2 text-[13px] text-danger">{error}</div>}
          {items.length > 0 && items[0].position > 0 && <p className="mt-2 text-center text-[12px] text-muted">Showing the latest messages. Earlier ones are in T3 Code on {machine?.label ?? "that machine"}.</p>}
          {items.map((item) => item.type === "user_message"
            ? <div key={item.itemId} className="mt-3 flex flex-col items-end"><div className="bubble max-w-[85%] rounded-[18px] px-3.5 py-[7px] text-[14px] leading-[22px] whitespace-pre-wrap" style={{ background: "var(--bubble-user)", color: "var(--bubble-user-fg)" }}>{item.text}</div></div>
            : <div key={item.itemId} className="mt-3 flex max-w-[92%] flex-col items-start"><div className="md bubble rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px] break-words"><RichMarkdown>{(item.text ?? "") + (item.textTruncated ? "\n\n…" : "")}</RichMarkdown></div></div>)}
          {working && <p role="status" className="mt-3 text-[13px] text-muted">Working on {machine?.label ?? "the other machine"}…</p>}
        </div>
      </div>
      <form className="mx-auto mb-3 flex w-full max-w-[760px] items-end gap-2 px-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea aria-label={`Message this thread on ${machine?.label ?? "the other machine"}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} placeholder={`Message on ${machine?.label ?? "the other machine"}`}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          className="min-h-10 flex-1 resize-none rounded-[20px] border border-line bg-elevated px-3.5 py-2 text-[14px] outline-none" />
        <IconButton type="submit" aria-label="Send" disabled={!draft.trim() || sending} className={clsx("size-10", sending && "opacity-50")}><Send size={16} /></IconButton>
      </form>
    </section>
  );
}
