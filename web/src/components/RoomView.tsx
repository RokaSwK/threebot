import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, Pencil, Square, Users, X } from "lucide-react";
import { Avatar, GroupAvatar } from "./Avatar";
import { BotLink } from "./BotMention";
import { ApprovalCard, QuestionCard, SecretCard } from "./Cards";
import { MentionMenu } from "./MentionMenu";
import { RichMarkdown } from "./RichMarkdown";
import { IconButton, Spinner } from "./ui";
import { UserMessageText } from "./UserMessageText";
import { ensureRoom, loadRoom, openDialog, sendRoomMessage, stopRoom, stopRoomPoll, useApp, watchThread } from "../store";
import { activeMentionQuery, mentionSuggestions, withMention, type MentionBot } from "../lib/mentionMenu";
import { botTextColor } from "../lib/character";
import { roomCards, type RoomCard } from "../lib/roomCards";
import { mentionsInText } from "../../../server/mention-rules.mts";
import type { MemberView, RoomTurn } from "../lib/rooms";
import type { TurnItem } from "../lib/types";
import "../mobile-chat.css";

type Reply = { id: string; at: string; member: MemberView; text: string; runId: string | null; pass: boolean; late: boolean };
type TimelineRow =
  | { kind: "user"; id: string; at: string; turn: RoomTurn }
  | { kind: "reply"; id: string; at: string; reply: Reply }
  | { kind: "pass"; id: string; at: string; reply: Reply }
  | RoomCard;

/**
 * One room timeline: the user's turns from the room index and each member's replies from its own
 * room thread. The view re-reads the room every 2 s while open (see `ensureRoom`).
 */
export function RoomView({ roomId, onBack }: { roomId: string; onBack?: () => void }) {
  const room = useApp((s) => (s.roomView?.id === roomId ? s.roomView : null));
  const error = useApp((s) => (s.selectedRoom === roomId ? s.roomError : null));
  const threadData = useApp((s) => s.threadData);
  const threads = useApp((s) => s.threads);
  const bots = useApp((s) => s.bots);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");

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

  const lateRuns = useMemo(() => new Set((room?.turns ?? []).flatMap((turn) => (turn.runs ?? []).flatMap((run) => (run.late && run.runId ? [run.runId] : [])))), [room?.turns]);

  const replies = useMemo<Reply[]>(() => {
    if (!room) return [];
    const out: Reply[] = [];
    for (const member of room.members) {
      if (!member.threadId) continue;
      const data = threadData[member.threadId];
      if (!data) continue;
      // One room line per run: the last completed assistant message, as the room engine reads it.
      const latest = new Map<string, TurnItem>();
      for (const item of Object.values(data.items)) {
        if ((item.type !== "assistant_message" && item.type !== "assistant") || item.status !== "completed") continue;
        const key = item.runId ?? item.id;
        const previous = latest.get(key);
        if (!previous || item.ordinal >= previous.ordinal) latest.set(key, item);
      }
      for (const item of latest.values()) {
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (!text) continue;
        // `(pass)` is the room's "nothing to add": it is not a Bot line, but the view still says the
        // member was asked and declined, so a whole silent room doesn't look broken.
        const pass = /^\(pass\)$/i.test(text);
        out.push({ id: `${member.threadId}:${item.id}`, at: item.completedAt ?? item.updatedAt, member, text, runId: item.runId ?? null, pass, late: !!item.runId && lateRuns.has(item.runId) });
      }
    }
    return out;
  }, [room, threadData, lateRuns]);

  // A member can stop mid-turn to ask for approval, a question or a secret. Those cards live in its
  // thread; the room shows the pending ones inline so the user never has to leave the room to
  // unblock a member. Resolved cards stay out: the member's reply is the room line.
  const cards = useMemo(() => roomCards(room, threadData, bots), [room, threadData, bots]);

  const timeline = useMemo<TimelineRow[]>(() => {
    const rows: TimelineRow[] = [
      ...(room?.turns ?? []).map((turn) => ({ kind: "user" as const, id: `turn:${turn.id}`, at: turn.at, turn })),
      ...replies.map((reply) => reply.pass
        ? { kind: "pass" as const, id: `pass:${reply.id}`, at: reply.at, reply }
        : { kind: "reply" as const, id: `reply:${reply.id}`, at: reply.at, reply }),
      ...cards,
    ];
    return rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  }, [room?.turns, replies, cards]);

  /** A member with a pending card is not "answering": it stopped and needs the user. */
  const waiting = useMemo(() => new Set(cards.map((card) => card.member.slug)), [cards]);

  const latestTurn = room?.turns.at(-1);
  const running = latestTurn?.status === "running";
  const answering = useMemo(() => {
    if (!room || !latestTurn || latestTurn.status !== "running") return [];
    const fromRuns = (latestTurn.runs ?? []).flatMap((run) => {
      if (!run.runId || replies.some((reply) => reply.runId === run.runId)) return [];
      const member = room.members.find((candidate) => candidate.slug === run.slug);
      return member ? [member] : [];
    });
    if (fromRuns.length > 0) return fromRuns;
    // The turn index fills `runs` as each member finishes; until then the member thread's shell
    // says who is still working.
    return room.members.filter((member) => {
      if (!member.threadId) return false;
      const shell = threads[member.threadId];
      return ["preparing", "queued", "starting", "running", "waiting"].includes(shell?.activityRunStatus ?? shell?.status ?? "");
    });
  }, [room, latestTurn, replies, threads]);

  const quotes = useMemo(() => {
    const map = new Map<string, string>();
    for (const turn of room?.turns ?? []) map.set(turn.id, turn.text);
    for (const reply of replies) map.set(reply.id, reply.text);
    return map;
  }, [room?.turns, replies]);

  const botNames = useMemo(() => Object.values(bots).map((bot) => ({ slug: bot.slug, name: bot.name })), [bots]);

  useEffect(() => {
    if (!stick.current) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [timeline.length, answering.length, running]);

  const halt = async () => {
    if (!room || stopping) return;
    setStopping(true);
    setActionError("");
    try {
      await stopRoom(room.id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't stop the room");
    } finally {
      setStopping(false);
    }
  };

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

  const modeLabel = room.settings.mode === "panel" ? "Panel" : "Roundtable";
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
            <span className="chat-status block truncate text-[11px] text-muted">{modeLabel} · {room.members.length} members</span>
          </span>
        </button>
        <div className="pointer-events-auto absolute right-3 flex gap-1">
          {running && (
            <IconButton onClick={() => void halt()} disabled={stopping} title="Stop" aria-label="Stop" className="bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90">
              {stopping ? <Spinner /> : <Square size={13} fill="currentColor" />}
            </IconButton>
          )}
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
        <div className="chat-messages mx-auto flex w-full max-w-[960px] flex-col px-4 pt-16 pb-4">
          <p className="mx-auto my-2 max-w-[560px] text-center text-[11.5px] text-faint">
            {room.settings.mode === "panel"
              ? "Panel: members answer independently and don't see each other's replies."
              : "Roundtable: members speak in order and hear each other; a member's @mention brings that teammate back in."}
          </p>
          {notReady.length > 0 && (
            <p role="status" className="mx-auto my-2 rounded-full bg-card px-3 py-1.5 text-[12.5px] text-muted">
              {notReady.map((member) => member.name).join(", ")} {notReady.length === 1 ? "is" : "are"} not ready yet.
            </p>
          )}
          {timeline.length === 0 && !running && (
            <p className="py-10 text-center text-[13px] text-muted">No messages yet. Say hello or @mention a member.</p>
          )}

          {timeline.map((row) => row.kind === "user" ? (
            <div key={row.id} className="fade-up mt-3 flex flex-col items-end">
              {row.turn.replyTo && quotes.get(row.turn.replyTo) && <p className="chat-reply-chip">{quotes.get(row.turn.replyTo)}</p>}
              <div data-message-body="plain" className="bubble rounded-[18px] px-3.5 py-[7px] text-[14px] leading-[22px] whitespace-pre-wrap" style={{ background: "var(--bubble-user)", color: "var(--bubble-user-fg)" }}>
                <UserMessageText text={row.turn.text} />
              </div>
              {row.turn.status === "stopped" && <p className="chat-model-switch">Stopped</p>}
              {row.turn.status === "interrupted" && <p className="chat-model-switch">Interrupted</p>}
              {row.turn.status === "failed" && <p className="chat-model-switch">Failed</p>}
            </div>
          ) : row.kind === "pass" ? (
            <p key={row.id} className="fade-up mt-1.5 pl-9 text-[11.5px] text-faint">{row.reply.member.name} passed</p>
          ) : row.kind === "card" ? (
            <div key={row.id} className="fade-up mt-3 flex items-start gap-2">
              <Avatar shape={row.member.shape} color={row.member.color} picture={row.member.avatarImage} size={26} />
              <div className="min-w-0 w-full max-w-[85%]">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium" style={{ color: botTextColor(row.member.color) }}>{row.member.name}</span>
                  <span className="text-[11px] text-faint">{time(row.at)} · needs you</span>
                </div>
                {row.entry.kind === "approval"
                  ? <ApprovalCard entry={row.entry} threadId={row.threadId} />
                  : row.entry.kind === "question"
                    ? <QuestionCard entry={row.entry} threadId={row.threadId} />
                    : <SecretCard entry={row.entry} threadId={row.threadId} />}
              </div>
            </div>
          ) : (
            <div key={row.id} className="fade-up mt-3 flex items-start gap-2">
              <Avatar shape={row.reply.member.shape} color={row.reply.member.color} picture={row.reply.member.avatarImage} size={26} />
              <div className="min-w-0 max-w-[85%]">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium" style={{ color: botTextColor(row.reply.member.color) }}>{row.reply.member.name}</span>
                  <span className="text-[11px] text-faint">{time(row.reply.at)}{row.reply.late ? " · late" : ""}</span>
                </div>
                <div data-message-body="markdown" className="md bubble fade-up rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px] break-words">
                  <RichMarkdown bots={botNames} components={{ a: BotLink }}>{row.reply.text}</RichMarkdown>
                </div>
              </div>
            </div>
          ))}

          {answering.map((member) => (
            <div key={`answering:${member.slug}`} className="fade-up flex items-center gap-2 py-2 pl-1 text-[13px]">
              <Avatar shape={member.shape} color={member.color} picture={member.avatarImage} size={20} />
              <span className="shimmer-text">{waiting.has(member.slug) ? `${member.name} is waiting for you` : `${member.name} is answering…`}</span>
            </div>
          ))}
          {running && answering.length === 0 && (latestTurn?.runs?.length ?? 0) === 0 && (
            <div className="flex items-center gap-2 py-2 pl-1 text-[13px] text-muted"><Spinner size={13} /> Waiting for the members…</div>
          )}
        </div>
      </div>

      {actionError && <p role="alert" className="shrink-0 px-5 pb-1 text-[12.5px] text-danger">{actionError}</p>}
      <RoomComposer roomId={room.id} members={room.members} mentionPolicy={room.settings.mentionPolicy} lead={room.settings.lead} defaultResponder={room.settings.defaultResponder} />
    </section>
  );
}

function RoomComposer({ roomId, members, mentionPolicy, lead, defaultResponder }: { roomId: string; members: MemberView[]; mentionPolicy: "anywhere" | "leading"; lead: string; defaultResponder: "lead" | "everyone" | "mentions" }) {
  const [text, setText] = useState("");
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const dismissed = useRef<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  const candidates = useMemo<MentionBot[]>(() => [
    ...members.map((member) => ({ slug: member.slug, name: member.name, label: member.label, shape: member.shape, color: member.color, avatarImage: member.avatarImage })),
    { slug: "all", name: "all", label: "Everyone in the room" },
  ], [members]);

  const suggestions = useMemo(() => (mention ? mentionSuggestions(mention.query, candidates) : []), [mention, candidates]);

  // Who this draft addresses, read with the same rules the server uses (mention-rules.mts). The chips
  // answer "who is going to see this?" before sending, and a room has no other way to show it.
  const addressed = useMemo(() => {
    if (!text.trim()) return [] as { key: string; name: string; member?: MemberView }[];
    const matched = new Set(mentionsInText(text, members.map((member) => member.name), mentionPolicy).map((name) => name.toLowerCase()));
    return [...matched].map((key) => {
      if (key === "all" || key === "everyone") return { key, name: "Everyone" };
      const member = members.find((candidate) => candidate.name.toLowerCase() === key);
      return { key, name: member?.name ?? key, member };
    });
  }, [text, members, mentionPolicy]);

  const removeMention = (name: string) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setText((current) => current.replace(new RegExp(`@${escaped}`, "i"), "").replace(/[ \t]{2,}/g, " ").trimStart());
    setMention(null);
    dismissed.current = null;
    requestAnimationFrame(() => ta.current?.focus({ preventScroll: true }));
  };

  const leadName = members.find((member) => member.slug === lead)?.name ?? "the lead";
  const responderHint = defaultResponder === "everyone"
    ? "No @mention: every member answers"
    : defaultResponder === "mentions"
      ? "No @mention: nobody answers"
      : `No @mention: ${leadName} answers`;

  const recompute = (value: string, cursor: number | null) => {
    if (cursor === null || dismissed.current === value) { setMention(null); return; }
    const query = activeMentionQuery(value, cursor, candidates);
    if (!query) { setMention(null); return; }
    setMention((current) => {
      const list = mentionSuggestions(query.query, candidates);
      return { start: query.start, query: query.query, index: Math.min(current?.index ?? 0, Math.max(0, list.length - 1)) };
    });
  };

  const pick = (picked: MentionBot) => {
    const element = ta.current;
    const cursor = element?.selectionStart ?? text.length;
    const next = withMention(text, cursor, picked);
    setText(next.value);
    setMention(null);
    requestAnimationFrame(() => {
      element?.focus({ preventScroll: true });
      element?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  useEffect(() => {
    const element = ta.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
    element.style.overflowY = element.scrollHeight > 120 ? "auto" : "hidden";
  }, [text]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const names = members.map((member) => member.name);
    // The server's explicit list wins and ignores "@all" as a slug, so it expands to every member.
    const mentions = Array.from(new Set(mentionsInText(trimmed, names, mentionPolicy).flatMap((name) => {
      if (name === "all") return members.map((member) => member.slug);
      const member = members.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      return member ? [member.slug] : [];
    })));
    setSending(true);
    setError("");
    try {
      await sendRoomMessage(roomId, trimmed, mentions);
      setText("");
      setMention(null);
      dismissed.current = null;
      requestAnimationFrame(() => ta.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send the message");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-composer shrink-0 px-5 pb-5">
      <div className="composer-content mx-auto w-full max-w-[820px]">
        {error && <p role="alert" className="px-1 pb-1 text-[12.5px] text-danger">{error}</p>}
        <div className="composer-shell relative rounded-[22px] border border-line bg-elevated focus-within:border-line-strong">
          {mention && (
            <MentionMenu
              bots={suggestions}
              query={mention.query}
              activeIndex={mention.index}
              onPick={pick}
              onHover={(index) => setMention((current) => current ? { ...current, index } : null)}
              hint="@all brings in every member"
            />
          )}
          <div className="flex min-h-[24px] flex-wrap items-center gap-1.5 px-3 pt-2 text-[11.5px]">
            {addressed.length > 0 ? (
              <>
                <span className="text-faint">To</span>
                {addressed.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => removeMention(item.name)}
                    title={`Remove @${item.name}`}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-1.5 py-0.5 hover:bg-hover"
                  >
                    {item.member
                      ? <Avatar shape={item.member.shape} color={item.member.color} picture={item.member.avatarImage} size={13} />
                      : <Users size={12} className="text-muted" />}
                    <span style={item.member ? { color: botTextColor(item.member.color) } : undefined}>{item.name}</span>
                    <X size={11} className="text-faint" />
                  </button>
                ))}
              </>
            ) : (
              <span className="text-faint">{responderHint}</span>
            )}
          </div>
          <div className="composer-controls flex items-end gap-1.5 p-1.5">
            <textarea
              ref={ta}
              value={text}
              rows={1}
              placeholder="Message the room"
              aria-label="Message the room"
              className="scroll-thin max-h-[120px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[14px] leading-[22px] outline-none placeholder:text-faint"
              onChange={(event) => {
                dismissed.current = null;
                const value = event.currentTarget.value;
                setText(value);
                recompute(value, event.currentTarget.selectionStart);
              }}
              onSelect={(event) => recompute(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyUp={(event) => {
                if (!["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(event.key)) recompute(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              onCompositionStart={() => setMention(null)}
              onCompositionEnd={(event) => recompute(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (mention) {
                  if (suggestions.length > 0) {
                    if (event.key === "ArrowDown") { event.preventDefault(); setMention((current) => current ? { ...current, index: (current.index + 1) % suggestions.length } : null); return; }
                    if (event.key === "ArrowUp") { event.preventDefault(); setMention((current) => current ? { ...current, index: (current.index - 1 + suggestions.length) % suggestions.length } : null); return; }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      const picked = suggestions[mention.index];
                      if (picked) pick(picked);
                      return;
                    }
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    dismissed.current = event.currentTarget.value;
                    setMention(null);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {(text.trim().length > 0 || sending) && (
              <IconButton onClick={() => void submit()} disabled={sending || !text.trim()} className="size-9 bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90" title="Send" aria-label="Send">
                {sending ? <Spinner /> : <ArrowUp size={17} />}
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function time(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
