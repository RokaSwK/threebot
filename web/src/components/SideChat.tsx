import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageCircle, Trash2, X } from "lucide-react";
import { IconButton } from "./ui";
import { bringBackSideChat, closeSideChat, deleteSideChat, openSideChat, toast, useApp } from "../store";
import { bringBackRun, sideChatSignal, sideChatsOf, threadBusy } from "../lib/sideChats";
import type { Bot } from "../lib/types";
import "./SideChat.css";

/** The conversation itself is the Chat passed as children, embedded over its parent. */
export function SideChatSheet({ bot, parentThreadId, threadId, children }: { bot: Bot; parentThreadId: string; threadId: string; children: ReactNode }) {
  const shell = useApp((s) => s.threads[threadId]);
  const parent = useApp((s) => s.threads[parentThreadId]);
  const runs = useApp((s) => s.threadData[threadId]?.runs);
  const run = bringBackRun(Object.values(runs ?? {}));
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const blocked = threadBusy(parent) ? `Bring back when ${bot.name} is idle` : !run ? "Bring back after a finished reply" : null;
  const seen = useRef(false);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closeSideChat(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  // Deleted here or on another device: nothing is left to show.
  useEffect(() => {
    if (shell) seen.current = true;
    else if (seen.current) closeSideChat();
  }, [shell]);

  const act = async (action: () => Promise<void>) => {
    setWorking(true);
    try { await action(); }
    catch (error) { toast(error instanceof Error ? error.message : "That didn't work. Try again."); }
    finally { setWorking(false); }
  };
  return <aside className="side-chat-sheet" role="dialog" aria-label="Side chat">
    <header className="side-chat-bar">
      <span className="side-chat-heading">
        <span className="side-chat-title">{shell?.title ?? "Side chat"}</span>
        <span className="side-chat-hint">{blocked ?? `Goes into your next message to ${bot.name}`}</span>
      </span>
      <button type="button" className="side-chat-back" disabled={!!blocked || !run || working} onClick={() => run && void act(async () => { await bringBackSideChat(threadId, parentThreadId, run.id); toast(`${bot.name} gets this with your next message`); })}>Bring back</button>
      {confirming
        ? <button type="button" className="side-chat-delete" disabled={working} onClick={() => void act(() => deleteSideChat(threadId))}>Delete?</button>
        : <IconButton title="Delete side chat" aria-label="Delete side chat" onClick={() => setConfirming(true)}><Trash2 size={15} /></IconButton>}
      <IconButton title="Close side chat" aria-label="Close side chat" onClick={closeSideChat}><X size={17} /></IconButton>
    </header>
    <div className="side-chat-body">{children}</div>
  </aside>;
}

/** A closed side chat that has something to say. The full list lives in details. */
export function SideChatPill({ parentThreadId }: { parentThreadId: string }) {
  const threads = useApp((s) => s.threads);
  const open = useApp((s) => s.sideChat);
  if (open?.parentThreadId === parentThreadId) return null;
  const signal = sideChatsOf(threads, parentThreadId).flatMap((thread) => {
    const text = sideChatSignal(thread);
    return text ? [{ thread, text }] : [];
  })[0];
  if (!signal) return null;
  return <div className="side-chat-pill-row">
    <button type="button" className="side-chat-pill" onClick={() => openSideChat(parentThreadId, signal.thread.id)}>
      <MessageCircle size={13} aria-hidden="true" /><span className="truncate">{signal.thread.title}</span><span className="side-chat-pill-state">{signal.text}</span>
    </button>
  </div>;
}

export function SideChatList({ parentThreadId }: { parentThreadId: string }) {
  const threads = useApp((s) => s.threads);
  const chats = sideChatsOf(threads, parentThreadId);
  if (!chats.length) return null;
  return <section aria-label="Side chats" className="mb-5">
    <h3 className="mb-2 px-1 text-[12.5px] text-muted">Side chats</h3>
    <div className="overflow-hidden rounded-2xl bg-card p-1">
      {chats.map((chat) => <button key={chat.id} type="button" className="side-chat-row" onClick={() => openSideChat(parentThreadId, chat.id)}>
        <MessageCircle size={14} aria-hidden="true" /><span className="truncate">{chat.title}</span>{sideChatSignal(chat) && <span className="side-chat-pill-state">{sideChatSignal(chat)}</span>}
      </button>)}
    </div>
  </section>;
}
