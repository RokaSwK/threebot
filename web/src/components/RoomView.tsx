import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, Pencil } from "lucide-react";
import { Avatar, GroupAvatar } from "./Avatar";
import { BotLink } from "./BotMention";
import { RichMarkdown } from "./RichMarkdown";
import { IconButton, Spinner } from "./ui";
import { ensureRoom, loadRoom, openDialog, stopRoomPoll, useApp, watchThread } from "../store";
import { botTextColor } from "../lib/character";
import type { MemberView } from "../lib/rooms";
import type { TurnItem } from "../lib/types";
import "../mobile-chat.css";

type Reply = { id: string; at: string; member: MemberView; text: string };

/**
 * The foundation room view: one timeline of the members' own room threads, read-only. Sending and
 * the turn engine arrive with the next change; this page already owns the room's identity, its
 * member threads and its deep link.
 */
export function RoomView({ roomId, onBack }: { roomId: string; onBack?: () => void }) {
  const room = useApp((s) => (s.roomView?.id === roomId ? s.roomView : null));
  const error = useApp((s) => (s.selectedRoom === roomId ? s.roomError : null));
  const threadData = useApp((s) => s.threadData);
  const bots = useApp((s) => s.bots);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    ensureRoom(roomId);
  }, [roomId]);

  // The poll belongs to the open view; unmounting the room must not leave an interval behind.
  useEffect(() => () => {
    if (useApp.getState().selectedRoom === roomId) stopRoomPoll();
  }, [roomId]);

  // The same subscription Chat uses: watchThread feeds threadData for every member thread.
  const threadKey = room ? room.members.flatMap((member) => (member.threadId ? [member.threadId] : [])).join("|") : "";
  useEffect(() => {
    const unsubs = (threadKey ? threadKey.split("|") : []).map((threadId) => watchThread(threadId));
    return () => { for (const unsubscribe of unsubs) unsubscribe(); };
  }, [threadKey]);

  const replies = useMemo<Reply[]>(() => {
    if (!room) return [];
    const out: Reply[] = [];
    for (const member of room.members) {
      if (!member.threadId) continue;
      const data = threadData[member.threadId];
      if (!data) continue;
      // One room line per run: the last completed assistant message of that run.
      const latest = new Map<string, TurnItem>();
      for (const item of Object.values(data.items)) {
        if ((item.type !== "assistant_message" && item.type !== "assistant") || item.status !== "completed") continue;
        const key = item.runId ?? item.id;
        const previous = latest.get(key);
        if (!previous || item.ordinal >= previous.ordinal) latest.set(key, item);
      }
      for (const item of latest.values()) {
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (!text || /^\(pass\)$/i.test(text)) continue;
        out.push({ id: `${member.threadId}:${item.id}`, at: item.completedAt ?? item.updatedAt, member, text });
      }
    }
    return out.sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0));
  }, [room, threadData]);

  const botNames = useMemo(() => Object.values(bots).map((bot) => ({ slug: bot.slug, name: bot.name })), [bots]);

  useEffect(() => {
    if (!stick.current) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [replies.length]);

  if (!room) {
    return (
      <section className="chat-view relative flex h-full min-w-0 flex-1 flex-col bg-chat">
        <div className="flex h-[52px] shrink-0 items-center gap-2 px-3">
          {onBack && <IconButton onClick={onBack} className="chat-back" aria-label="Back"><ChevronLeft size={24} /></IconButton>}
          <span className="truncate text-[13.5px] text-muted">{error ? "Room unavailable" : "Loading room…"}</span>
        </div>
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          {error ? (
            <div>
              <p role="alert" className="max-w-[420px] text-[13.5px] text-muted">{error}</p>
              <button type="button" onClick={() => void loadRoom(roomId)} className="mt-3 rounded-full bg-pill px-4 py-1.5 text-[13px] text-pill-fg">Try again</button>
            </div>
          ) : <Spinner size={18} />}
        </div>
      </section>
    );
  }

  const notReady = room.members.filter((member) => member.status !== "ready");

  return (
    <section className="chat-view relative flex h-full min-w-0 flex-1 flex-col bg-chat">
      <header className="chat-header pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[52px] items-center justify-center bg-gradient-to-b from-[var(--bg-chat)] from-50% to-transparent px-3">
        {onBack && (
          <IconButton onClick={onBack} className="chat-back pointer-events-auto absolute left-2" aria-label="Back">
            <ChevronLeft size={24} />
          </IconButton>
        )}
        <button type="button" onClick={() => openDialog({ kind: "room", id: room.id })} className="chat-title pointer-events-auto flex h-8 max-w-[55%] items-center gap-2 rounded-full border border-line bg-chat/80 pr-3.5 pl-1.5 backdrop-blur hover:bg-hover" title="Room settings">
          <GroupAvatar members={room.members} size={onBack ? 26 : 24} />
          <span className="chat-title-text min-w-0">
            <span className="chat-title-name flex min-w-0 items-center gap-1.5 text-[13.5px]"><span className="truncate">{room.name}</span></span>
            <span className="chat-status block truncate text-[11px] text-muted">Read-only · {room.members.length} members</span>
          </span>
        </button>
        <div className="pointer-events-auto absolute right-3 flex gap-1">
          <IconButton onClick={() => openDialog({ kind: "room", id: room.id })} title="Room settings" aria-label="Room settings">
            <Pencil size={16} />
          </IconButton>
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
        className="chat-scroller scroll-thin min-h-0 flex-1 overflow-y-auto"
      >
        <div className="chat-messages mx-auto flex w-full max-w-[960px] flex-col px-4 pt-16 pb-8">
          <p className="mx-auto my-2 max-w-[560px] text-center text-[11.5px] text-faint">
            Read-only: this page shows each member's own thread.
          </p>
          {notReady.length > 0 && (
            <p role="status" className="mx-auto my-2 rounded-full bg-card px-3 py-1.5 text-[12.5px] text-muted">
              {notReady.map((member) => member.name).join(", ")} {notReady.length === 1 ? "is" : "are"} not ready yet.
            </p>
          )}
          {replies.length === 0 && (
            <p className="py-10 text-center text-[13px] text-muted">No messages yet. Each member answers in its own thread.</p>
          )}

          {replies.map((reply) => (
            <div key={reply.id} className="fade-up mt-3 flex items-start gap-2">
              <Avatar shape={reply.member.shape} color={reply.member.color} picture={reply.member.avatarImage} size={26} />
              <div className="min-w-0 max-w-[85%]">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium" style={{ color: botTextColor(reply.member.color) }}>{reply.member.name}</span>
                  <span className="text-[11px] text-faint">{time(reply.at)}</span>
                </div>
                <div data-message-body="markdown" className="md bubble fade-up rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px] break-words">
                  <RichMarkdown bots={botNames} components={{ a: BotLink }}>{reply.text}</RichMarkdown>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function time(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
