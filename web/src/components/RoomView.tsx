import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, ChevronRight, RefreshCw, Square, Users, X } from "lucide-react";
import { Avatar, GroupAvatar } from "./Avatar";
import { BotLink } from "./BotMention";
import { ApprovalCard, QuestionCard, SecretCard } from "./Cards";
import { MentionMenu } from "./MentionMenu";
import { RichMarkdown } from "./RichMarkdown";
import { RoomMembers } from "./RoomMembers";
import { IconButton, Pill, Spinner } from "./ui";
import { ChatAttachmentList, PendingAttachments } from "./ChatAttachments";
import { ComposerActions } from "./ComposerActions";
import { usePendingAttachments } from "../lib/pendingAttachments";
import { UserMessageText } from "./UserMessageText";
import { ensureRoom, loadRoom, resetRoom, sendRoomMessage, stopRoom, stopRoomPoll, toast, useApp, watchThread } from "../store";
import { activeMentionQuery, mentionEdit, mentionSuggestions, type MentionBot } from "../lib/mentionMenu";
import { replaceText } from "../lib/chatBehavior";
import { botTextColor } from "../lib/character";
import { roomCards, type RoomCard } from "../lib/roomCards";
import { clearRoomDraft, readRoomDraft, writeRoomDraft } from "../lib/roomDrafts";
import { useMobileChat } from "../lib/useMobileChat";
import { delegatedRows, roomLines, type DelegatedRow, type RoomLine } from "../lib/roomDelegation";
import { subagentStatus } from "../lib/threadFamily";
import { mentionsInText } from "../../../server/mention-rules.mts";
import type { MemberView, RoomTurn } from "../lib/rooms";
import "../mobile-chat.css";

type Reply = RoomLine;
type EventRow = { kind: "event"; id: string; at: string; text: string; tone?: "danger" };
type TimelineRow =
  | { kind: "user"; id: string; at: string; turn: RoomTurn }
  | { kind: "reply"; id: string; at: string; reply: Reply }
  | { kind: "pass"; id: string; at: string; reply: Reply }
  | { kind: "delegated"; id: string; at: string; row: DelegatedRow }
  | EventRow
  | RoomCard;

/**
 * One room timeline: the user's turns from the room index and each member's replies from its own
 * room thread. The view re-reads the room every 2 s while open (see `ensureRoom`).
 */
export function RoomView({ roomId, onBack }: { roomId: string; onBack?: () => void }) {
  const room = useApp((s) => (s.roomView?.id === roomId ? s.roomView : null));
  const offline = useApp((s) => s.offline);
  // A live room index can still show replies painted from a member's saved copy: that is a copy too.
  const stale = useApp((s) => s.selectedRoom === roomId && (s.roomStale || (s.roomView?.members ?? []).some((member) => !!member.threadId && s.threadData[member.threadId]?.stale === true)));
  // Storage already answered that there is no copy: the page does not wait for the network to say so.
  const missing = useApp((s) => s.selectedRoom === roomId && s.roomMissing);
  // The gateway said the room is gone; its copy is not a way back in.
  const gone = useApp((s) => s.selectedRoom === roomId && s.roomGone);
  const error = useApp((s) => (s.selectedRoom === roomId ? s.roomError : null));
  const threadData = useApp((s) => s.threadData);
  const threads = useApp((s) => s.threads);
  const bots = useApp((s) => s.bots);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);

  useEffect(() => {
    ensureRoom(roomId);
  }, [roomId]);

  // The poll belongs to the open view; unmounting the room must not leave an interval behind.
  useEffect(() => () => {
    if (useApp.getState().selectedRoom === roomId) stopRoomPoll();
  }, [roomId]);

  /** Current members plus the ones that left: their threads still hold the room's history. */
  const historyMembers = useMemo(() => (room ? [...room.members, ...(room.formerMembers ?? [])] : []), [room]);

  // The same subscription Chat uses: watchThread feeds threadData for every member thread.
  const threadKey = historyMembers.flatMap((member) => (member.threadId ? [member.threadId] : [])).join("|");
  useEffect(() => {
    const unsubs = (threadKey ? threadKey.split("|") : []).map((threadId) => watchThread(threadId, false));
    return () => { for (const unsubscribe of unsubs) unsubscribe(); };
  }, [threadKey]);

  /** Runs the room actually recorded; a message sent directly in a member's thread stays out. */

  const replies = useMemo<Reply[]>(() => roomLines(historyMembers, room?.turns ?? [], threadData), [historyMembers, room?.turns, threadData]);
  const delegated = useMemo(() => delegatedRows(historyMembers, room?.turns ?? [], threadData), [historyMembers, room?.turns, threadData]);
  const knownRuns = useMemo(
    () => new Set([...(room?.turns ?? []).flatMap((turn) => turn.runs.flatMap((run) => run.runId ? [run.runId] : [])),
      ...delegated.flatMap((row) => row.chain.runIds)]),
    [room?.turns, delegated],
  );
  const cards = useMemo(() => roomCards(room, threadData, bots, knownRuns), [room, threadData, bots, knownRuns]);

  const nameOf = useMemo(() => {
    const names = new Map(historyMembers.map((member) => [member.slug, member.name]));
    return (slug: string) => names.get(slug) ?? slug;
  }, [historyMembers]);

  /** Room-level outcomes that have no bubble of their own: stops, crashes and silent members. */
  const events = useMemo<EventRow[]>(() => {
    const rows: EventRow[] = [];
    for (const turn of room?.turns ?? []) {
      if (turn.status === "stopped") rows.push({ kind: "event", id: `event:${turn.id}:stopped`, at: turn.at, text: "You stopped the room" });
      if (turn.status === "interrupted") rows.push({ kind: "event", id: `event:${turn.id}:interrupted`, at: turn.at, text: "Threebot restarted before this message was answered" });
      const failedRuns = (turn.runs ?? []).filter((run) => run.status === "failed");
      for (const run of failedRuns) {
        rows.push({
          kind: "event",
          id: `event:${turn.id}:failed:${run.runId ?? run.slug}`,
          at: run.at ?? turn.at,
          text: `${nameOf(run.slug)} couldn't answer${run.error ? ` — ${run.error}` : ""}`,
          tone: "danger",
        });
      }
      for (const run of (turn.runs ?? []).filter((candidate) => candidate.status === "timeout")) {
        rows.push({
          kind: "event",
          id: `event:${turn.id}:late:${run.runId ?? run.slug}`,
          at: run.at ?? turn.at,
          text: run.delegationTimedOut
            ? `${nameOf(run.slug)} timed out waiting for delegated work`
            : `${nameOf(run.slug)} didn't answer in time`,
        });
      }
      if (turn.status === "failed" && !turn.runs.some((run) => run.status === "failed" || run.status === "timeout")) {
        rows.push({ kind: "event", id: `event:${turn.id}:failed`, at: turn.at, text: "The room failed", tone: "danger" });
      }
    }
    return rows;
  }, [room?.turns, nameOf]);

  const timeline = useMemo<TimelineRow[]>(() => {
    const rows: TimelineRow[] = [
      ...(room?.turns ?? []).map((turn) => ({ kind: "user" as const, id: `turn:${turn.id}`, at: turn.at, turn })),
      ...events,
      ...replies.map((reply) => reply.pass
        ? { kind: "pass" as const, id: `pass:${reply.id}`, at: reply.at, reply }
        : { kind: "reply" as const, id: `reply:${reply.id}`, at: reply.at, reply }),
      ...delegated.map((row) => ({ kind: "delegated" as const, id: row.id, at: row.at, row })),
      ...cards,
    ];
    return rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  }, [room?.turns, events, replies, delegated, cards]);

  /** A member with a pending card is not "answering": it stopped and needs the user. */
  const waiting = useMemo(() => new Set(cards.map((card) => card.member.slug)), [cards]);

  const latestTurn = room?.turns.at(-1);
  const running = (room?.turns ?? []).some((turn) => turn.status === "running");
  const answering = useMemo(() => {
    if (!room || latestTurn?.status !== "running") return [];
    const fromRuns = (latestTurn.runs ?? []).flatMap((run) => {
      if (!run.runId || run.status) return [];
      const member = room.members.find((candidate) => candidate.slug === run.slug);
      return member ? [member] : [];
    });
    if (fromRuns.length > 0) return fromRuns;
    // Before the dispatch is recorded, use the member thread's live status.
    return room.members.filter((member) => {
      if (!member.threadId) return false;
      const shell = threads[member.threadId];
      if (shell?.activeRunId && latestTurn.runs.some((run) => run.status && (run.runId === shell.activeRunId || run.replyRunId === shell.activeRunId))) return false;
      return ["preparing", "queued", "starting", "running", "waiting"].includes(shell?.activityRunStatus ?? shell?.status ?? "");
    });
  }, [room, latestTurn, threads]);

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
          <span className="truncate text-[13.5px] text-muted">{offline ? "Offline" : gone || error ? "Room unavailable" : "Loading room…"}</span>
        </div>
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          {gone ? (
            // Deleted on another device: the copy was forgotten, so this page will not come back.
            <div className="mx-auto flex w-full max-w-[320px] flex-col items-center" role="status">
              <h2 className="text-[16px] font-medium">This room no longer exists</h2>
              <p className="mt-1 text-[13.5px] text-muted">It may have been deleted on another device.</p>
              {onBack && <button type="button" onClick={onBack} className="mt-3 rounded-full bg-pill px-4 py-1.5 text-[13px] text-pill-fg">Go back</button>}
            </div>
          ) : missing && offline ? (
            // Nothing kept for this room: it comes from the gateway, and the gateway is not answering.
            <div className="mx-auto flex w-full max-w-[320px] flex-col items-center" role="status">
              <h2 className="text-[16px] font-medium">Not on this device yet</h2>
              <p className="mt-1 text-[13.5px] text-muted">It will load when the gateway is reachable.</p>
            </div>
          ) : error ? (
            // The gateway answered, and not with a room: keep the raw error for whoever needs it.
            <div className="mx-auto flex w-full max-w-[320px] flex-col items-center">
              <h2 className="text-[16px] font-medium">Couldn't load this room</h2>
              <p className="mt-1 text-[13.5px] text-muted">Try again in a moment.</p>
              <button type="button" onClick={() => void loadRoom(roomId)} className="mt-3 rounded-full bg-pill px-4 py-1.5 text-[13px] text-pill-fg">Try again</button>
              <details className="mt-3 w-full text-left">
                <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">Technical details</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-card p-2 font-mono text-[11px] text-muted">{error}</pre>
              </details>
            </div>
          ) : <Spinner size={18} />}
        </div>
      </section>
    );
  }

  const modeLabel = room.settings.mode === "panel" ? "Panel" : "Roundtable";
  const modeHint = room.settings.mode === "panel"
    ? "Panel: each Bot answers on its own and doesn't see the others. @mention a Bot to choose who answers."
    : "Roundtable: they speak in order and hear each other. A member's @mention brings that teammate back in.";
  const notReady = room.members.filter((member) => member.status !== "ready");
  const pendingMembers = notReady.filter((member) => member.status === "pending").map((member) => member.name);
  const unavailableMembers = notReady.filter((member) => member.status === "unavailable").map((member) => member.name);

  return (
    <section className="chat-view relative flex h-full min-w-0 flex-1 flex-col bg-chat">
      <header className="chat-header pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[52px] items-center justify-center bg-gradient-to-b from-[var(--bg-chat)] from-50% to-transparent px-3">
        {onBack && (
          <IconButton onClick={onBack} className="chat-back pointer-events-auto absolute left-2" aria-label="Back">
            <ChevronLeft size={24} />
          </IconButton>
        )}
        <button
          type="button"
          onClick={() => setMembersOpen(true)}
          className="chat-title pointer-events-auto flex h-8 max-w-[55%] items-center gap-2 rounded-full border border-line bg-chat/80 pr-3.5 pl-1.5 backdrop-blur hover:bg-hover"
          title="Room details and member threads"
        >
          <GroupAvatar members={room.members} size={onBack ? 26 : 24} />
          <span className="chat-title-text min-w-0">
            <span className="chat-title-name flex min-w-0 items-center gap-1.5 text-[13.5px]"><span className="truncate">{room.name}</span></span>
            <span className="chat-status block truncate text-[11px] text-muted">{offline ? (stale ? "Offline · Saved copy" : "Offline") : stale ? "Saved copy" : `${modeLabel} · ${room.members.length} ${room.members.length === 1 ? "Bot" : "Bots"}`}</span>
          </span>
        </button>
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
          {notReady.length > 0 && (
            <p role="status" className="mx-auto my-2 rounded-full bg-card px-3 py-1.5 text-center text-[12.5px] text-muted">
              {pendingMembers.length > 0 && <>{pendingMembers.join(", ")} {pendingMembers.length === 1 ? "is" : "are"} not ready yet.</>}
              {pendingMembers.length > 0 && unavailableMembers.length > 0 ? " " : null}
              {unavailableMembers.length > 0 && <>{unavailableMembers.join(", ")} {unavailableMembers.length === 1 ? "is" : "are"} unavailable.</>}
            </p>
          )}
          {timeline.length === 0 && !running && (
            <div className="room-empty">
              <GroupAvatar members={room.members} size={44} />
              <p className="text-[14px] font-medium text-fg">No messages yet</p>
              <p className="max-w-[420px] text-[12.5px] leading-[18px] text-muted">{modeHint}</p>
            </div>
          )}

          {timeline.map((row) => row.kind === "user" ? (
            <div key={row.id} className="fade-up mt-3 flex flex-col items-end">
              {!!row.turn.attachments?.length && <ChatAttachmentList attachments={row.turn.attachments} align="end" owner={`room:${roomId}`} />}
              {row.turn.text.trim() !== "" && (
                <div data-message-body="plain" className="bubble rounded-[18px] px-3.5 py-[7px] text-[14px] leading-[22px] whitespace-pre-wrap" style={{ background: "var(--bubble-user)", color: "var(--bubble-user-fg)" }}>
                  <UserMessageText text={row.turn.text} muted />
                </div>
              )}
              {row.turn.status === "queued" && <p className="chat-model-switch">Queued · the room is answering first</p>}
              {row.turn.status !== "queued" && row.turn.status !== "running" && row.turn.attachments?.length && row.turn.attachments.every((attachment) => attachment.id.startsWith("pending-")) && (
                <p className="pt-1 text-[11px] text-faint">No Bot received these files.</p>
              )}
            </div>
          ) : row.kind === "event" ? (
            <p key={row.id} role="status" className={`room-event ${row.tone === "danger" ? "room-event-danger" : ""}`}>{row.text}</p>
          ) : row.kind === "pass" ? (
            <p key={row.id} className="fade-up mt-1.5 pl-9 text-[11.5px] text-faint">{row.reply.member.name} passed</p>
          ) : row.kind === "card" ? (
            <div key={row.id} id={`room-card:${row.id}`} className="fade-up mt-3 flex scroll-mt-24 items-start gap-2">
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
          ) : row.kind === "delegated" ? (
            <div key={row.id} className="fade-up mt-2 flex items-start gap-2">
              <Avatar shape={row.row.member.shape} color={row.row.member.color} picture={row.row.member.avatarImage} size={26} />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium" style={{ color: botTextColor(row.row.member.color) }}>{row.row.member.name}</span>
                  <span className="text-[11px] text-faint">{time(row.at)}{row.row.late ? " · late" : ""}</span>
                </div>
                <details className="group max-w-[85%] rounded-[12px] border border-line bg-card px-3 py-2">
                  <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-[8px] text-[12.5px] text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                    <span className="truncate">{delegatedSummary(row.row)}</span>
                    <ChevronRight size={13} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
                  </summary>
                  <ul role="list" className="mt-2 space-y-1.5">
                    {row.row.tasks.map((task) => {
                      const state = taskState(task.status);
                      const meta = [task.driver, task.model?.split("/").pop()].filter(Boolean).join(" · ");
                      return (
                        <li key={`${row.id}:${task.childThreadId || task.subagentId || task.title}`} className="flex min-w-0 items-start gap-2">
                          <span
                            aria-hidden="true"
                            className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-current ${state === "working" ? "text-attention motion-safe:animate-pulse" : state === "failed" ? "text-danger" : state === "done" ? "text-success" : "text-muted"}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px]" title={task.title ?? undefined}>{task.title || "Delegated task"}</span>
                            <span className="block truncate text-[11px] text-muted" title={[task.driver, task.model].filter(Boolean).join(" · ") || undefined}>
                              {meta ? `${meta} · ${subagentStatus(task.status)}` : subagentStatus(task.status)}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              </div>
            </div>
          ) : (
            <div key={row.id} className="fade-up mt-3 flex items-start gap-2">
              <Avatar shape={row.reply.member.shape} color={row.reply.member.color} picture={row.reply.member.avatarImage} size={26} />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium" style={{ color: botTextColor(row.reply.member.color) }}>{row.reply.member.name}</span>
                  {row.reply.member.removed && <span className="text-[11px] text-faint">left the room</span>}
                  <span className="text-[11px] text-faint">{time(row.reply.at)}{row.reply.late ? " · late" : ""}</span>
                </div>
                <div data-message-body="markdown" className="md bubble fade-up w-fit rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px] break-words">
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

      {cards.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const first = cards[0];
            document.getElementById(`room-card:${first.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
          }}
          className="room-needs-you shrink-0"
        >
          <span className="size-2 rounded-full bg-[var(--attention)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">
            {cards.length === 1 ? `${cards[0].member.name} needs you` : `${cards.length} Bots need you`}
          </span>
          <span className="text-muted">Review</span>
        </button>
      )}
      {actionError && <p role="alert" className="shrink-0 px-5 pb-1 text-[12.5px] text-danger">{actionError}</p>}
      <RoomComposer
        roomId={room.id}
        members={room.members}
        mentionPolicy={room.settings.mentionPolicy}
        lead={room.settings.lead}
        defaultResponder={room.settings.defaultResponder}
        running={running}
        stopping={stopping}
        onStop={() => void halt()}
      />
      {membersOpen && <RoomMembers room={room} onClose={() => setMembersOpen(false)} />}
    </section>
  );
}

function RoomComposer({ roomId, members, mentionPolicy, lead, defaultResponder, running, stopping, onStop }: {
  roomId: string;
  members: MemberView[];
  mentionPolicy: "anywhere" | "leading";
  lead: string;
  defaultResponder: "lead" | "everyone" | "mentions";
  running: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const offline = useApp((s) => s.offline);
  // A saved room's members may have changed: nothing is sent until the room itself is live.
  const savedCopy = useApp((s) => s.selectedRoom === roomId && s.roomStale);
  const mobile = useMobileChat();
  const initialDraft = useMemo(() => readRoomDraft(roomId), [roomId]);
  const [text, setText] = useState(initialDraft.text);
  const attachments = usePendingAttachments(initialDraft.attachments);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const plus = useRef<HTMLButtonElement>(null);
  const resetGroup = useRef<HTMLDivElement>(null);
  const dismissed = useRef<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const candidates = useMemo<MentionBot[]>(() => [
    ...members.map((member) => ({ slug: member.slug, name: member.name, label: member.label, shape: member.shape, color: member.color, avatarImage: member.avatarImage })),
    { slug: "all", name: "all", label: "Everyone in the room" },
  ], [members]);

  const suggestions = useMemo(() => (mention ? mentionSuggestions(mention.query, candidates) : []), [mention, candidates]);

  // Who this draft addresses, read with the same rules the server uses (mention-rules.mts). The chips
  // answer "who is going to see this?" before sending, and a room has no other way to show it.
  const addressed = useMemo(() => {
    if (!text.trim()) return [] as { key: string; name: string; member?: MemberView }[];
    const matched = new Set(mentionsInText(text, [...members.map((member) => member.name), "everyone"], mentionPolicy).map((name) => name.toLowerCase()));
    return [...matched].map((key) => {
      if (key === "all" || key === "everyone") return { key, name: "Everyone" };
      const member = members.find((candidate) => candidate.name.toLowerCase() === key);
      return { key, name: member?.name ?? key, member };
    });
  }, [text, members, mentionPolicy]);

  // The draft belongs to the room, not to this mount: going back or reloading keeps it, files included.
  useEffect(() => {
    const uploading = attachments.items
      .filter((item) => item.state === "uploading")
      .map(({ attachment }) => ({ type: attachment.type, id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }));
    writeRoomDraft(roomId, { text, attachments: attachments.ready.map(({ type, id, name, mimeType, sizeBytes }) => ({ type, id, name, mimeType, sizeBytes })), uploading });
  }, [roomId, text, attachments.items, attachments.ready]);

  // A draft that came back from disk may contain files whose upload died with the page. They
  // cannot be resumed, so the composer says so instead of dropping them silently.
  useEffect(() => {
    const interrupted = initialDraft.uploading.length;
    if (interrupted === 0) return;
    toast(interrupted === 1 ? "1 file didn't finish uploading. Attach it again." : `${interrupted} files didn't finish uploading. Attach them again.`);
  }, [initialDraft]);

  const removeMention = (name: string) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setText((current) => current.replace(new RegExp(`@${escaped}`, "i"), "").replace(/[ \t]{2,}/g, " ").trimStart());
    setMention(null);
    dismissed.current = null;
    requestAnimationFrame(() => ta.current?.focus({ preventScroll: true }));
  };

  const leadName = members.find((member) => member.slug === lead)?.name ?? "the lead";
  const responderHint = defaultResponder === "everyone"
    ? "No @mention: every Bot answers"
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
    if (!element) return;
    element.focus({ preventScroll: true });
    replaceText(element, mentionEdit(element.value, element.selectionStart, picked), setText);
    setMention(null);
  };

  useEffect(() => {
    const element = ta.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
    element.style.overflowY = element.scrollHeight > 120 ? "auto" : "hidden";
  }, [text]);

  const submit = async () => {
    // Enter reaches this too, so the offline guard belongs here and not only on the Send button.
    if (offline || savedCopy) return;
    const trimmed = text.trim();
    if ((!trimmed && attachments.ready.length === 0) || sending || resetting || attachments.busy) return;
    const names = members.map((member) => member.name);
    // The server's explicit list wins and ignores "@all" as a slug, so it expands to every member.
    // `@all` and `@everyone` both mean every member, as on the server.
    const mentions = Array.from(new Set(mentionsInText(trimmed, [...names, "everyone"], mentionPolicy).flatMap((name) => {
      if (name === "all" || name.toLowerCase() === "everyone") return members.map((member) => member.slug);
      const member = members.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      return member ? [member.slug] : [];
    })));
    setSending(true);
    setError("");
    try {
      await sendRoomMessage(roomId, trimmed, mentions, null, attachments.ready);
      setText("");
      attachments.clear();
      clearRoomDraft(roomId);
      setMention(null);
      dismissed.current = null;
      requestAnimationFrame(() => ta.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send the message");
    } finally {
      setSending(false);
    }
  };

  /** Start over: the same threads, a fresh session each, and no messages left to read. */
  const startOver = async () => {
    if (resetting || sending) return;
    setResetting(true);
    setError("");
    try {
      await resetRoom(roomId);
      // What was written but not sent is not part of the conversation being cleared.
      setMention(null);
      setConfirmReset(false);
      toast("Room restarted with fresh sessions");
      requestAnimationFrame(() => ta.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't start the room over");
    } finally {
      setResetting(false);
    }
  };

  const cancelReset = () => {
    setConfirmReset(false);
    plus.current?.focus({ preventScroll: true });
  };

  // Opening the question takes focus out of the menu that asked it; the calm answer gets it.
  useEffect(() => {
    if (confirmReset) resetGroup.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmReset]);

  return (
    <div className="chat-composer shrink-0 px-5 pb-5">
      <div className="composer-content mx-auto w-full max-w-[820px]">
        {error && <p role="alert" className="px-1 pb-1 text-[12.5px] text-danger">{error}</p>}
        <div className="composer-shell relative rounded-[22px] border border-line bg-elevated focus-within:border-line-strong">
          {mention && suggestions.length > 0 && (
            <MentionMenu
              id={listId}
              bots={suggestions}
              query={mention.query}
              activeIndex={mention.index}
              onPick={pick}
              onHover={(index) => setMention((current) => current ? { ...current, index } : null)}
              hint="@all brings in every member"
            />
          )}
          {(addressed.length > 0 || focused) && (
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
                      aria-label={`Remove @${item.name}`}
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
          )}
          {confirmReset && (
            <div ref={resetGroup} role="group" aria-label="Start over" className="flex flex-wrap items-center gap-2 px-3 pt-3 text-[12.5px]">
              <span className="mr-auto text-muted">Clear this room's messages and start every Bot a fresh session?</span>
              <Pill variant="ghost" disabled={resetting} onClick={cancelReset}>Cancel</Pill>
              <Pill variant="danger" disabled={resetting} onClick={() => void startOver()}>{resetting && <Spinner />} Start over</Pill>
            </div>
          )}
          <PendingAttachments items={attachments.items} onRemove={attachments.remove} />
          {offline && (
            <p className="px-3 pt-1.5 text-[11.5px] text-muted">You're offline. Your draft is kept here until the connection is back.</p>
          )}
          <div className="composer-controls flex items-end gap-1.5 p-1.5">
            <ComposerActions
              mobile={mobile}
              onFiles={attachments.addFiles}
              triggerRef={plus}
              resetKey={roomId}
              actions={[{ key: "start-over", label: "Start over", icon: RefreshCw, onSelect: () => setConfirmReset(true) }]}
            />
            <textarea
              ref={ta}
              value={text}
              rows={1}
              placeholder="Message the room"
              aria-label="Message the room"
              aria-autocomplete="list"
              aria-controls={mention ? listId : undefined}
              aria-expanded={mention ? true : undefined}
              aria-activedescendant={mention && suggestions.length > 0 ? `${listId}-opt-${mention.index}` : undefined}
              enterKeyHint={mobile ? "enter" : undefined}
              className="scroll-thin max-h-[120px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[14px] leading-[22px] outline-none placeholder:text-faint"
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                dismissed.current = null;
                const value = event.currentTarget.value;
                setText(value);
                recompute(value, event.currentTarget.selectionStart);
              }}
              onSelect={(event) => recompute(event.currentTarget.value, event.currentTarget.selectionStart)}
              onCompositionStart={() => setMention(null)}
              onCompositionEnd={(event) => recompute(event.currentTarget.value, event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (mention && suggestions.length > 0) {
                  if (event.key === "ArrowDown") { event.preventDefault(); setMention((current) => current ? { ...current, index: (current.index + 1) % suggestions.length } : null); return; }
                  if (event.key === "ArrowUp") { event.preventDefault(); setMention((current) => current ? { ...current, index: (current.index - 1 + suggestions.length) % suggestions.length } : null); return; }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const picked = suggestions[mention.index];
                    if (picked) pick(picked);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    dismissed.current = event.currentTarget.value;
                    setMention(null);
                    return;
                  }
                }
                // On a phone Enter is the newline key; the send button is the only way to send.
                if (!mobile && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {running && (
              <IconButton onClick={onStop} disabled={stopping} className="size-9 bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90" title="Stop" aria-label="Stop">
                {stopping ? <Spinner /> : <Square size={13} fill="currentColor" />}
              </IconButton>
            )}
            {(text.trim().length > 0 || attachments.items.length > 0 || sending) && (
              <IconButton onClick={() => void submit()} disabled={offline || savedCopy || sending || resetting || attachments.busy || (!text.trim() && attachments.ready.length === 0)} className="size-9 bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90" title={offline ? "You're offline. Reconnect to send." : "Send"} aria-label={offline ? "You're offline. Reconnect to send." : "Send"}>
                {sending ? <Spinner /> : <ArrowUp size={17} />}
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One line for a delegation card: how many tasks and how far they are, never the whole list. */
function delegatedSummary(row: DelegatedRow): string {
  const total = row.tasks.length;
  const count = { working: 0, done: 0, failed: 0, stopped: 0 };
  for (const task of row.tasks) count[taskState(task.status)] += 1;
  const parts = [`${total} ${total === 1 ? "task" : "tasks"}`];
  if (count.working > 0) parts.push(`${count.working} working`);
  if (count.done > 0) parts.push(`${count.done} done`);
  if (count.failed > 0) parts.push(`${count.failed} failed`);
  if (count.stopped > 0) parts.push(`${count.stopped} stopped`);
  return `Delegated ${parts.join(" · ")}`;
}

/** The four states a delegated task's dot and the card's summary share. */
function taskState(status: string): "working" | "done" | "failed" | "stopped" {
  if (["pending", "preparing", "queued", "starting", "running", "waiting"].includes(status)) return "working";
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled" || status === "rolled_back") return "failed";
  return "stopped";
}

function time(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
