import { memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { defaultUrlTransform } from "react-markdown";
import { ArrowDown, ArrowUp, AudioLines, Camera, ChevronLeft, Globe, FileText, Folder, Image, MessageCircle, Mic, Monitor, PanelRight, Plus, Square, X } from "lucide-react";
import { Avatar, botColor } from "./Avatar";
import { BotMention, BotEvent } from "./BotMention";
import { BotExchange } from "./BotExchange";
import { ApprovalCard, AutomatedCard, DateSep, ErrorLine, EventLine, FileCard, PageCard, QuestionCard, SecretCard, SubagentCard, ToolImage, useBotsByThread } from "./Cards";
import { WorkspaceFileContext, WorkspaceMessageImage, WorkspaceResourceViewer } from "./WorkspaceResource";
import { workspaceFilePath, workspaceLinkPath } from "../lib/workspaceLinks";
import { RichMarkdown } from "./RichMarkdown";
import { BoardItemChip } from "./Projects";
import { parseItemLink } from "../lib/projects";
import { ChatMessageActions } from "./ChatMessageActions";
import { ChatAttachmentList } from "./ChatAttachments";
import { ExecutorConnectCard } from "./ExecutorConnectCard";
import { useVoiceSettings, VoiceDock, voiceChatSupported } from "./VoiceDock";
import { requestMicrophone, readVoiceSettings, voiceLang } from "../lib/voiceChat";
import { isExecutorUrl } from "../lib/executor";
import { IconButton, Spinner } from "./ui";
import { avatarStateFor } from "./Sidebar";
import { openDialog, botStatus, conversationStatus, loadThreadMeta, selectThread, setDetailsOpen, startSideChat, toast, useApp, watchThread } from "../store";
import { supplementSubagents, threadIdentity, threadLink } from "../lib/threadFamily";
import { parseThreadLink } from "../lib/botMessages";
import { buildEntries, isActiveRun, modelSwitches, workingPhrases, type Entry } from "../lib/transcript";
import { getTriggerDisplayModelName } from "../lib/modelTraits";
import { canStartSideChat, parseSideCommand } from "../lib/sideChats";
import { SideChatPill, SideChatSheet } from "./SideChat";
import type { Bot } from "../lib/types";
import { composerFocusBehavior, MOBILE_CHAT_QUERY, splitBubbles, takeAttachmentFiles } from "../lib/chatBehavior";
import { chatDraft } from "../lib/chatDrafts";
import { parseReply, replyLabel, withReply } from "../lib/reply";
import { activeWork, messageCommand, useRuntimeWork, useWorkCommand } from "../lib/runtimeApi";
import { QueuedWork, WorkFeedback } from "./QueuedWork";
import { PlanMessage, PlanItemMessage } from "./PlanMessage";
import { GoalCard } from "./GoalCard";
import { TaskChanges } from "./TaskChanges";
import { useChatScroll } from "../lib/chatScroll";
import "../mobile-chat.css";

const ConversationWork = memo(function ConversationWork({ threadId, readOnly }: { threadId: string; readOnly: boolean }) {
  const state = useRuntimeWork(threadId);
  return <>
    <QueuedWork state={state} />
    {state.plans.slice(-3).map(plan => <ArtifactPlan key={plan.id} threadId={threadId} plan={plan} />)}
    <GoalCard threadId={threadId} state={state} readOnly={readOnly} />
    <TaskChanges state={state} />
    {state.error && <p className="my-2 text-[12px] text-muted" role="status">Task details unavailable. Reconnect to refresh.</p>}
  </>;
});

const ArtifactPlan = memo(function ArtifactPlan({ threadId, plan }: { threadId: string; plan: Parameters<typeof PlanMessage>[0]["plan"] }) {
  const inTranscript = useApp(s => Object.values(s.threadData[threadId]?.items ?? {}).some(item => (item.type === "todo_list" || item.type === "proposed_plan") && item.planId === plan.id));
  return inTranscript ? null : <PlanMessage plan={plan} />;
});

function StopAllButton({ threadId }: { threadId: string }) {
  const state = useRuntimeWork(threadId);
  const shell = useApp(s => s.threads[threadId]);
  const action = useWorkCommand(`${threadId}:${shell?.activeRunId}:${shell?.pendingRuntimeRequest?.id}:${state.runs.filter(run => ["preparing", "running", "starting", "waiting"].includes(run.status)).map(run => `${run.id}:${run.status}`).join(",")}:${state.background}`);
  return <div className="composer-stop relative"><IconButton disabled={action.disabled} onClick={() => void action.send({ type: "thread.stop", threadId, stopDelegatedTasks: true })} className="size-9 bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90" title="Stop" aria-label="Stop"><Square size={13} fill="currentColor" /></IconButton>{action.state === "error" && <div className="absolute right-0 bottom-full z-20 w-52 rounded-xl bg-elevated p-2 shadow-lg"><WorkFeedback action={action} /></div>}</div>;
}

export function Chat({ bot, threadId = bot.mainThreadId, onBack, embedded = false }: { bot: Bot; threadId?: string | null; onBack?: () => void; embedded?: boolean }) {
  useEffect(() => (threadId ? watchThread(threadId) : undefined), [threadId]);
  const data = useApp((s) => (threadId ? s.threadData[threadId] : undefined));
  const shell = useApp((s) => (threadId ? s.threads[threadId] : undefined));
  const threads = useApp((s) => s.threads);
  const identity = threadId ? threadIdentity(bot, threadId, threads) : bot;
  const isChild = !!threadId && threadId !== bot.mainThreadId;
  const tasks = useApp((s) => s.tasks);
  const detailsOpen = useApp((s) => s.detailsOpen);
  const exchangeBotSlug = useApp((s) => s.exchangeBotSlug);
  const exchangeBot = useApp((s) => exchangeBotSlug ? s.bots[exchangeBotSlug] ?? s.historicalBots[exchangeBotSlug] : undefined);
  const archived = useApp((s) => s.bots[bot.slug]?.mainThreadId !== bot.mainThreadId);
  const settings = useApp((s) => s.settings);
  const botsByThread = useBotsByThread();
  const vault = useApp((s) => s.vault);
  const vaultSites = useMemo(() => Object.fromEntries((vault ?? []).flatMap((i) => (i.type === "login" ? [[i.id, i.domain || i.title]] : []))), [vault]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [voiceChat, setVoiceChat] = useState(false);
  const voiceCalls = useApp((s) => (threadId ? s.threadMeta?.[threadId]?.voiceCalls : undefined));
  useEffect(() => {
    setVoiceChat(false);
    if (!threadId) return;
    void loadThreadMeta(threadId);
    const refresh = () => { if (document.visibilityState === "visible") void loadThreadMeta(threadId); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [threadId]);

  const items = useMemo(() => supplementSubagents(Object.values(data?.items ?? {}), Object.values(data?.subagents ?? {}), threadId ?? ""), [data?.items, data?.subagents, threadId]);
  const providers = useApp((s) => s.providers);
  const sideChat = useApp((s) => s.sideChat);
  const runs = useMemo(() => Object.values(data?.runs ?? {}), [data?.runs]);
  const switches = useMemo(() => modelSwitches(runs, (selection) => {
    const provider = providers.find((p) => p.instanceId === selection.instanceId);
    const model = provider?.models.find((m) => m.slug === selection.model);
    return model ? getTriggerDisplayModelName(model, provider?.driver) : selection.model;
  }), [runs, providers]);
  const entries = useMemo(() => buildEntries(items, { bot, botsByThread, tasks, requests: data?.requests ?? {}, vaultSites, voiceCalls, modelSwitches: switches }), [items, bot, botsByThread, tasks, data?.requests, vaultSites, voiceCalls, switches]);
  const activeRun = runs.filter(run => isActiveRun(run) && run.status !== "queued").sort((a, b) => b.ordinal - a.ordinal)[0];
  const working = Boolean(activeRun) && !shell?.pendingRuntimeRequest;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 3500);
    return () => window.clearInterval(t);
  }, [working]);
  const phrases = working ? workingPhrases(items, activeRun?.id ?? null) : [];
  const phrase = activeRun?.status === "preparing" ? "Getting ready…" : phrases.length ? phrases[tick % phrases.length] : "";
  const status = isChild && threadId ? conversationStatus(threadId) : botStatus(bot);

  const { scroller, showJump, onScrollCapture, onUserScrollIntent, visibleEntries, hiddenCount, loadEarlier } = useChatScroll({ threadKey: threadId ?? `bot:${bot.slug}`, loaded: data?.loaded === true, entries });
  const workspace = useMemo(() => ({ workspaceRoot: bot.workspaceRoot, threadId, openFile: setOpenFile }), [bot.workspaceRoot, threadId]);

  const greeting = data?.loaded && !entries.some((e) => e.kind === "user" || e.kind === "bot");
  const reply = (text: string) => chatDraft(bot, threadId).setReply(text);
  const voiceObservation = useMemo(() => {
    const lastUser = entries.findLastIndex((e) => e.kind === "user");
    const replies = entries.slice(lastUser + 1).flatMap((e) => (e.kind === "bot" && e.text ? [e] : []));
    return { replyId: replies.at(-1)?.id ?? null, replyText: replies.map((e) => e.text).join("\n\n"), working, waiting: !!shell?.pendingRuntimeRequest };
  }, [entries, working, shell?.pendingRuntimeRequest]);

  return (
    <section className="chat-view relative flex h-full min-w-0 flex-1 flex-col bg-chat">
      <div className="contents" inert={!!exchangeBot}>
      {!embedded && <header className="chat-header pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[52px] items-center justify-center bg-gradient-to-b from-[var(--bg-chat)] from-50% to-transparent px-3">
        {(onBack || isChild) && (
          <IconButton onClick={isChild ? () => selectThread(bot, shell?.lineage.parentThreadId ?? bot.mainThreadId ?? threadId) : onBack} className="chat-back pointer-events-auto absolute left-2" aria-label={isChild ? "Back to parent thread" : "Back"}>
            <ChevronLeft size={24} />
          </IconButton>
        )}
        <button onClick={() => setDetailsOpen(!detailsOpen)} className="chat-title pointer-events-auto flex h-8 max-w-[55%] items-center gap-2 rounded-full border border-line bg-chat/80 pr-3.5 pl-1.5 backdrop-blur hover:bg-hover" title="View conversation details">
          <Avatar shape={identity.shape} color={identity.color} picture={identity.avatarImage} size={onBack ? 26 : 24} state={isChild ? status === "failed" ? "failed" : working ? "working" : shell?.pendingRuntimeRequest ? "waiting" : "idle" : avatarStateFor(botStatus(bot))} />
          <span className="chat-title-text min-w-0"><span className="chat-title-name block truncate text-[13.5px]">{identity.name}</span>{statusLine(status) && <span className="chat-status block truncate text-[11px] text-muted">{statusLine(status)}</span>}</span>
        </button>
        <div className="pointer-events-auto absolute right-3 flex gap-1">
          <IconButton className="chat-computer" title="Open computer" onClick={() => openDialog({ kind: "computer", slug: bot.slug })}>
            <Monitor size={16} />
          </IconButton>
          {!detailsOpen && (
            <IconButton title="Show details" onClick={() => setDetailsOpen(true)}>
              <PanelRight size={16} />
            </IconButton>
          )}
        </div>
      </header>}

      <div
        ref={scroller}
        onScrollCapture={onScrollCapture}
        onWheelCapture={onUserScrollIntent}
        onPointerDownCapture={onUserScrollIntent}
        onTouchStartCapture={onUserScrollIntent}
        onKeyDownCapture={onUserScrollIntent}
        className="chat-scroller scroll-thin min-h-0 flex-1 overflow-y-auto"
      >
        <WorkspaceFileContext value={workspace}>
        <div className={clsx("chat-messages mx-auto flex w-full max-w-[960px] flex-col px-4 pb-4", embedded ? "pt-3" : "pt-16")}>
          {!data?.loaded && threadId && (
            <div className="flex justify-center py-10 text-muted">
              <Spinner size={18} />
            </div>
          )}
          {greeting && !embedded && (
            <BotBubble text={`Hey${settings?.userName ? ` ${settings.userName}` : ""}, good to meet you. What do you want me around for? Anything concrete, or more of a general sidekick?`} />
          )}
          {hiddenCount > 0 && <button className="mx-auto my-3 rounded-full bg-card px-4 py-2 text-[13px] text-muted hover:bg-hover" onClick={loadEarlier}>Load earlier messages</button>}
          {visibleEntries.map((e, i) => (
            <div key={e.id} className="contents" data-chat-entry={e.id}>
              <EntryView entry={e} prev={visibleEntries[i - 1]} bot={bot} threadId={threadId!} onOpenFile={setOpenFile} onReply={archived ? undefined : reply} accent={settings?.accent ?? "bot"} />
            </div>
          ))}
          {threadId && <ConversationWork threadId={threadId} readOnly={archived} />}
          {working && (
            <div className="fade-up flex items-center gap-2 py-2 pl-1 text-[13px]">
              <Avatar shape={identity.shape} color={identity.color} picture={identity.avatarImage} size={20} state={/^(Thinking|Mulling|Putting)/.test(phrase) ? "thinking" : "working"} />
              <span className="shimmer-text">{phrase}</span>
            </div>
          )}
        </div>
        </WorkspaceFileContext>
      </div>

      {showJump && (
        <button
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-28 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-line bg-elevated shadow-[var(--shadow-pop)]"
          aria-label="Scroll to latest"
        >
          <ArrowDown size={15} />
        </button>
      )}

      {threadId && !embedded && <SideChatPill parentThreadId={threadId} />}
      {voiceChat && threadId && <VoiceDock bot={identity === bot ? bot : { ...bot, ...identity }} threadId={threadId} observation={voiceObservation} onEnd={() => setVoiceChat(false)} />}
      {archived ? <div className="shrink-0 px-5 py-5 text-center text-[13px] text-muted">Archived Bot · This conversation is read-only.</div> : <Composer key={threadId ?? bot.slug} bot={bot} threadId={threadId} working={working} embedded={embedded} inVoiceChat={voiceChat} onVoiceChat={async () => {
        if (!threadId || !voiceChatSupported()) return;
        const problem = await requestMicrophone();
        if (problem) toast(problem); else setVoiceChat(true);
      }} />}
      {openFile && <FileViewer bot={bot} threadId={threadId} path={openFile} onOpenFile={setOpenFile} onClose={() => setOpenFile(null)} />}
      </div>
      {exchangeBot && !embedded && <BotExchange bot={bot} other={exchangeBot} />}
      {!embedded && threadId && sideChat?.parentThreadId === threadId && <SideChatSheet bot={bot} parentThreadId={threadId} threadId={sideChat.threadId}><Chat key={sideChat.threadId} bot={bot} threadId={sideChat.threadId} embedded /></SideChatSheet>}
    </section>
  );
}

function ReplyChip({ quote }: { quote: string }) {
  return <p className="chat-reply-chip" title={quote}>{replyLabel(quote)}</p>;
}

function duration(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function EntryView({ entry, prev, bot, threadId, onOpenFile, onReply, accent }: { entry: Entry; prev?: Entry; bot: Bot; threadId: string; onOpenFile: (p: string) => void; onReply?: (text: string) => void; accent: string }) {
  const tight = prev && prev.kind === entry.kind && (entry.kind === "bot" || entry.kind === "user");
  switch (entry.kind) {
    case "date":
      return <DateSep label={entry.label} />;
    case "event":
      return <EventLine entry={entry} />;
    case "automated":
      return <AutomatedCard entry={entry} />;
    case "model-switch":
      return <p className="chat-model-switch">{entry.text}</p>;
    case "voice-call":
      return <p className="chat-voice-call"><AudioLines size={16} aria-hidden="true" />Voice chat <span>· {duration(entry.seconds)}</span></p>;
    case "bot-event":
      return <BotEvent direction={entry.direction} bots={entry.bots} />;
    case "user":
      return (
        <ChatMessageActions text={entry.text} threadId={threadId} itemId={entry.id} runId={entry.runId} onReply={onReply} side="user" className={clsx("fade-up flex flex-col items-end", tight ? "mt-1" : "mt-3")}>
          {entry.replyTo && <ReplyChip quote={entry.replyTo} />}
          {entry.attachments.length > 0 && <AttachmentList attachments={entry.attachments} />}
          {entry.text && (
            <div
              data-message-body="plain" className="bubble rounded-[18px] px-3.5 py-[7px] text-[14px] leading-[22px] whitespace-pre-wrap"
              style={accent === "bot" && bot.color !== "white" && bot.color !== "gray" && bot.color !== "black" ? { background: botColor(bot.color), color: "#fff" } : { background: "var(--bubble-user)", color: "var(--bubble-user-fg)" }}
            >
              {entry.text}
            </div>
          )}
        </ChatMessageActions>
      );
    case "peer":
      return (
        <div className="chat-peer fade-up mt-1 flex items-end gap-2">
          {entry.fromBot ? <Avatar shape={entry.fromBot.shape} color={entry.fromBot.color} picture={entry.fromBot.avatarImage} size={22} /> : <span className="size-[22px]" />}
          <div className="md bubble rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px]">
            <MessageContent text={entry.text} />
          </div>
        </div>
      );
    case "bot":
      return (
        <div className={tight ? "mt-1" : "mt-3"}>
          {entry.attachments.length > 0 && <AttachmentList attachments={entry.attachments} align="start" />}
          {entry.text && <BotBubble text={entry.text} threadId={threadId} itemId={entry.id} runId={entry.runId} onReply={onReply} />}
        </div>
      );
    case "approval":
      return <ApprovalCard entry={entry} threadId={threadId} />;
    case "question":
      return <QuestionCard entry={entry} threadId={threadId} />;
    case "secret":
      return <SecretCard entry={entry} threadId={threadId} />;
    case "subagent":
      return <SubagentCard entry={entry} bot={bot} threadId={threadId} />;
    case "plan":
      return <PlanItemMessage item={entry.item} threadId={threadId} />;
    case "file":
      return <FileCard entry={entry} bot={bot} onOpen={onOpenFile} />;
    case "image":
      return <ToolImage entry={entry} threadId={threadId} botName={bot.name} />;
    case "page":
      return <PageCard entry={entry} />;
    case "error":
      return <ErrorLine message={entry.message} />;
  }
}

export function BotBubble({ text, threadId, itemId, runId, onReply }: { text: string; threadId?: string; itemId?: string; runId?: string | null; onReply?: (text: string) => void }) {
  // Agents often write several short paragraphs; they read best as stacked bubbles.
  const parts = splitBubbles(text);
  return (
    <ChatMessageActions text={text} threadId={threadId} itemId={itemId} runId={runId} onReply={onReply} side="bot">
      <div data-message-body="markdown" className="stack-left flex flex-col items-start gap-1">
        {parts.map((p, i) => (
          <div key={i} className="md bubble fade-up rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px] break-words">
            <MessageContent text={p} />
          </div>
        ))}
      </div>
    </ChatMessageActions>
  );
}

const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  const workspace = useContext(WorkspaceFileContext);
  const bots = useApp((s) => s.bots);
  // Bot polling replaces objects even when names have not changed. Markdown
  // parsing depends on those names, not on labels, run status or timestamps.
  const referencesKey = JSON.stringify(Object.values(bots).map((b) => ({ slug: b.slug, name: b.name })));
  return useMemo(() => <RichMarkdown bots={Object.values(bots).map((b) => ({ slug: b.slug, name: b.name }))} components={{ a: MessageLink, img: WorkspaceMessageImage }} urlTransform={(url) => parseThreadLink(url) || url.startsWith("bot:") || (workspace && workspaceLinkPath(url, workspace.workspaceRoot, workspace.fromPath)) ? url : defaultUrlTransform(url)}>{text}</RichMarkdown>, [text, referencesKey, workspace]);
});

/** Links to the user's Executor (sign-in links Bots post) render as Connect cards. */
function MessageLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const workspace = useContext(WorkspaceFileContext);
  const executorUrl = useApp((s) => s.executorUrl);
  const bots = useApp((s) => s.bots);
  const historical = useApp((s) => s.historicalBots);
  const threads = useApp((s) => s.threads);
  const reference = href ? parseThreadLink(href) : null;
  const mentioned = href?.startsWith("bot:") ? bots[decodeURIComponent(href.slice(4))] : reference ? [...Object.values(bots), ...Object.values(historical)].find((b) => b.mainThreadId === reference.threadId) : undefined;
  if (mentioned) return <BotMention bot={mentioned} />;
  if (reference) {
    const thread = threads[reference.threadId];
    const owner = thread && Object.values(bots).find((b) => b.projectId === thread.projectId);
    if (thread && owner) {
      const identity = threadIdentity(owner, thread.id, threads);
      return <button className="bot-mention inline-flex items-center gap-1 align-baseline font-medium hover:underline" style={{ color: botColor(owner.color) }} onClick={() => selectThread(owner, thread.id)}><Avatar shape={identity.shape} color={identity.color} picture={identity.avatarImage} size={14} />{identity.name}</button>;
    }
    return <a className="md-link" href={reference.environmentId ? threadLink({ kind: "remote", ...reference, environmentId: reference.environmentId, label: "T3 Code" }) : undefined} target="_blank" rel="noreferrer">{typeof children === "string" && children.startsWith("t3-thread:") ? "Open thread" : children}</a>;
  }
  if (href?.startsWith("bot:")) return <>{children}</>;
  const boardItem = href ? parseItemLink(href) : null;
  if (boardItem) return <BoardItemChip id={boardItem}>{children}</BoardItemChip>;
  const path = href && workspace ? workspaceLinkPath(href, workspace.workspaceRoot, workspace.fromPath) : null;
  if (path && workspace) return <button className="text-left underline" onClick={() => workspace.openFile(path)}>{children}</button>;
  // Unresolved local paths must never become browser URLs pointing at host files.
  if (!href || (!/^(https?:|mailto:|tel:)/i.test(href) && !href.startsWith("//") && !href.startsWith("#"))) return <>{children}</>;
  if (href && isExecutorUrl(href, executorUrl)) {
    const label = String(Array.isArray(children) ? children.join("") : (children ?? "")).replace(/^connect\s+/i, "") || "app";
    return <ExecutorConnectCard url={href} name={label} />;
  }
  return (
    <a className="md-link" href={href} target="_blank" rel="noreferrer">
      {/^https?:/i.test(href) && <Globe size={14} className="mr-1 inline-block align-baseline text-muted" aria-hidden="true" />}{children}
    </a>
  );
}


function AttachmentList({ attachments, align }: { attachments: unknown[]; align?: "start" | "end" }) {
  return <ChatAttachmentList attachments={attachments} align={align} />;
}

/** What the agent is doing right now, shown under its name. Quiet states show nothing. */
function statusLine(status: string) {
  return status === "working" ? "Working…" : status === "waiting" ? "Waiting for you" : status === "failed" ? "Something went wrong" : "";
}

// ---------- composer ----------
function useMobileChat() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_CHAT_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_CHAT_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

function AttachmentPicker({ mobile, open, onToggle, onClose, onFiles, onSideChat }: {
  mobile: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onFiles: (files: File[]) => void;
  onSideChat?: () => void;
}) {
  const libraryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectionOwners = useRef(new WeakMap<HTMLInputElement, typeof onFiles>());
  const choose = (input: HTMLInputElement | null) => {
    if (input) selectionOwners.current.set(input, onFiles);
    onClose();
    // Stay in this explicit user gesture; never ask for camera access on mount.
    input?.click();
  };
  const selected = (input: HTMLInputElement) => {
    const files = takeAttachmentFiles(input);
    const receive = selectionOwners.current.get(input) ?? onFiles;
    selectionOwners.current.delete(input);
    if (files.length) receive(files);
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);
  return (
    <div className="relative shrink-0">
      <IconButton onClick={onToggle} className="size-9 bg-hover" aria-label="Composer actions" aria-haspopup="menu" aria-expanded={open}>
        <Plus size={18} />
      </IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={onClose} />
          <div role="menu" aria-label="Attachments" className="chat-attachment-menu pop-in absolute bottom-11 left-0 z-50 w-[200px] max-w-[calc(100vw-3rem)] rounded-xl border border-line bg-elevated p-1 shadow-[var(--shadow-pop)]">
            <button role="menuitem" onClick={() => choose(fileInput.current)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
              <Folder size={14} /> {mobile ? "Choose File" : "Attach files"}
            </button>
            {mobile && <>
              <button role="menuitem" onClick={() => choose(cameraInput.current)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
                <Camera size={14} /> Take Photo
              </button>
              <button role="menuitem" onClick={() => choose(libraryInput.current)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
                <Image size={14} /> Photo or Video
              </button>
            </>}
            {onSideChat && <button role="menuitem" onClick={() => { onClose(); onSideChat(); }} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
              <MessageCircle size={14} /> Side chat
            </button>}
          </div>
        </>
      )}
      {/* Keep the inputs mounted while the menu closes so picker results still arrive. */}
      {mobile && <>
        <input ref={libraryInput} aria-label="Photo library" type="file" accept="image/*,video/*" multiple hidden onChange={(e) => selected(e.currentTarget)} />
        <input ref={cameraInput} aria-label="Take photo" type="file" accept="image/*" capture="environment" hidden onChange={(e) => selected(e.currentTarget)} />
      </>}
      <input ref={fileInput} aria-label="Files" type="file" multiple hidden onChange={(e) => selected(e.currentTarget)} />
    </div>
  );
}

function Composer({ bot, threadId, working, embedded, inVoiceChat, onVoiceChat }: { bot: Bot; threadId: string | null; working: boolean; embedded: boolean; inVoiceChat: boolean; onVoiceChat: () => void }) {
  const draft = chatDraft(bot, threadId);
  const { text, attachments: atts, sending, failed, replyTo } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const { setText, addFiles, setReply } = draft;
  const specialSend = useWorkCommand(`${threadId}:${text}:${atts.map(item => item.attachment.id).join(",")}`);
  const submitGoal = async () => {
    if (!threadId || sending || atts.some(item => item.state === "uploading")) return;
    const saved = draft.getSnapshot();
    const goal = /^\/goal(?:\s|$)/.test(saved.text.trim()) && !saved.attachments.length;
    const command = messageCommand(threadId, goal ? saved.text.trim() : withReply(saved.text.trim(), saved.replyTo), working, { attachments: saved.attachments.flatMap(item => item.state === "ready" ? [{ type: item.attachment.type, id: item.attachment.id, name: item.attachment.name, mimeType: item.attachment.mimeType, sizeBytes: item.attachment.sizeBytes }] : []) });
    await specialSend.send(command, () => {
      if (draft.getSnapshot().text === saved.text) setText("");
      if (draft.getSnapshot().replyTo === saved.replyTo) setReply(null);
      for (const item of saved.attachments) draft.removeAttachment(item.attachment.id);
    });
  };
  const sideChatsOn = useApp((s) => !embedded && s.runtimeFeatures.sideChats && canStartSideChat(threadId ? s.threads[threadId] : null));
  const submitSide = async (prompt: string) => {
    if (!threadId) return;
    if (atts.length) return toast("Side chats can't take attachments yet");
    const saved = text;
    setText("");
    if (!await startSideChat(bot, threadId, prompt) && !draft.getSnapshot().text) setText(saved);
  };
  const side = embedded ? null : parseSideCommand(text);
  const submit = () => side ? void submitSide(side.prompt) : /^\/goal(?:\s|$)/.test(text.trim()) && !atts.length ? void submitGoal() : draft.submit();
  const [popover, setPopover] = useState<"attachments" | null>(null);
  const [listening, setListening] = useState(false);
  const settings = useVoiceSettings();
  const activeRec = useRef<any>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const mobile = useMobileChat();
  const focus = useMemo(() => composerFocusBehavior(mobile), [mobile]);
  useEffect(() => {
    focus.onEntry(ta.current);
    setPopover(null);
  }, [draft, focus]);
  const replying = !!replyTo;
  useEffect(() => {
    if (!replying || !ta.current) return;
    // Choosing Reply is the explicit request for the keyboard.
    focus.onPointerDown(ta.current);
    ta.current.focus({ preventScroll: true });
  }, [replying, focus]);
  useEffect(() => {
    const el = ta.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
  }, [text, draft]);

  const dictate = async () => {
    if (listening && activeRec.current) {
      activeRec.current.stop?.();
      activeRec.current = null;
      setListening(false);
      return;
    }
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return toast("Voice input isn't available in this browser");
    const problem = await requestMicrophone();
    if (problem) return toast(problem);

    const rec = new SR();
    activeRec.current = rec;
    rec.continuous = false;
    rec.interimResults = true;
    const currentLang = voiceLang(readVoiceSettings());
    rec.lang = currentLang;
    let accumulated = "";
    const baseText = draft.getSnapshot().text;
    let written = baseText;
    rec.onresult = (ev: any) => {
      // Typing or sending while listening wins: stop rather than overwrite the draft or refill it.
      if (draft.getSnapshot().text !== written) {
        if (activeRec.current === rec) activeRec.current = null;
        rec.abort?.();
        setListening(false);
        return;
      }
      const results = Array.from(ev.results ?? []);
      accumulated = results.map((result: any) => result[0]?.transcript || "").join(" ").trim();
      if (accumulated) {
        written = (baseText ? baseText.trim() + " " : "") + accumulated;
        setText(written);
      }
    };
    rec.onerror = (ev: any) => {
      if (ev.error !== "no-speech" && ev.error !== "aborted") {
        toast(`Voice input error: ${ev.error}`);
      } else if (ev.error === "no-speech" && !accumulated) {
        toast(`Didn't hear anything (${currentLang})`);
      }
    };
    rec.onend = () => {
      if (activeRec.current === rec) activeRec.current = null;
      setListening(false);
    };
    setListening(true);
    try {
      rec.start();
    } catch (e: any) {
      setListening(false);
      activeRec.current = null;
      toast(`Could not start voice input: ${e?.message || e}`);
    }
  };

  return (
    <div className="chat-composer shrink-0 px-5 pb-5">
      <div
        className="composer-content mx-auto w-full max-w-[820px]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        <div ref={shellRef} className="composer-shell relative rounded-[22px] border border-line bg-elevated focus-within:border-line-strong">
          <div className="px-3"><WorkFeedback action={specialSend} /></div>
          {sending && <p role="status" className="px-3 text-[12px] text-muted">Sending…</p>}
          {failed.map((message) => (
            <div key={message.id} role="group" aria-label="Unsent message" className="min-w-0 border-b border-line px-3 py-2 text-[12.5px]">
              <p className="text-danger">Delivery not confirmed</p>
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{parseReply(message.text).text}</p>
              {message.attachments.map((attachment) => <p key={attachment.id} className="truncate">{attachment.name}</p>)}
              <div className="flex flex-wrap gap-3 pt-1">
                <button disabled={sending} onClick={() => draft.retry(message.id)} aria-label="Retry failed message" className="hover:underline disabled:opacity-50">Retry</button>
                <button disabled={sending || !!text || atts.length > 0} onClick={() => draft.restore(message.id)} aria-label="Edit failed message" className="hover:underline disabled:opacity-50">Edit{(text || atts.length > 0) ? " (clear draft first)" : ""}</button>
                <button onClick={() => draft.discard(message.id)} aria-label="Discard failed message" className="text-muted hover:underline">Discard</button>
              </div>
            </div>
          ))}
          {atts.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {atts.map(({ attachment: a, state }) => (
                <div key={a.id} className="chat-pending-attachment group relative">
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt="" className={clsx("size-14 rounded-xl object-cover", state === "uploading" && "opacity-50")} />
                  ) : (
                    <div className="flex h-14 items-center gap-2 rounded-xl bg-card px-3 text-[12.5px]">
                      <FileText size={14} /> <span className="max-w-[140px] truncate">{a.name}</span>
                    </div>
                  )}
                  {state === "uploading" && (
                    <span className="absolute inset-0 grid place-items-center">
                      <Spinner />
                    </span>
                  )}
                  <button onClick={() => draft.removeAttachment(a.id)} className="composer-remove-attachment absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-pill text-pill-fg" aria-label="Remove" title={`Remove ${a.name}`}>
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {replyTo && <div className="composer-reply"><span title={replyTo}>{replyLabel(replyTo)}</span><button type="button" aria-label="Cancel reply" onClick={() => setReply(null)}><X size={16} aria-hidden="true" /></button></div>}
          <div className="composer-controls flex items-end gap-1.5 p-1.5" data-expanded={replying}>
            <AttachmentPicker mobile={mobile} open={popover === "attachments"} onToggle={() => setPopover((v) => v === "attachments" ? null : "attachments")} onClose={() => setPopover(null)} onFiles={addFiles} onSideChat={sideChatsOn ? () => void startSideChat(bot, threadId!) : undefined} />
            <textarea
              ref={ta}
              readOnly={mobile}
              enterKeyHint={mobile ? "enter" : undefined}
              onPointerDown={(e) => focus.onPointerDown(e.currentTarget)}
              onPointerCancel={(e) => focus.onPointerCancel(e.currentTarget)}
              onClick={(e) => focus.onClick(e.currentTarget)}
              onFocus={(e) => focus.onFocus(e.currentTarget)}
              onBlur={(e) => focus.onBlur(e.currentTarget)}
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                  return;
                }
                if (!mobile && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={embedded ? "Ask on the side" : `Ask ${bot.name}`}
              className="scroll-thin max-h-[120px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[14px] leading-[22px] outline-none placeholder:text-faint"
            />
            {!inVoiceChat && <IconButton onClick={dictate} aria-pressed={listening} className={clsx("composer-dictate size-9", listening ? "bg-danger text-white hover:bg-danger hover:text-white animate-pulse" : "bg-hover text-muted")} title="Start voice input" aria-label={`Start voice input (${voiceLang(settings)})`}>
              <Mic size={16} />
            </IconButton>}
            {threadId && <ComposerRunAction threadId={threadId} working={working} hasDraft={!!text.trim() || atts.length > 0} inVoiceChat={inVoiceChat || embedded} onVoiceChat={onVoiceChat} />}
            {(text.trim() || atts.length > 0) && <IconButton onClick={submit} disabled={sending || specialSend.disabled || atts.some((item) => item.state === "uploading")} className="size-9 bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90" title="Send">
              <ArrowUp size={17} />
            </IconButton>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A receipt clears the draft, but only work state decides whether Stop disappears. */
function ComposerRunAction({ threadId, working, hasDraft, inVoiceChat, onVoiceChat }: { threadId: string; working: boolean; hasDraft: boolean; inVoiceChat: boolean; onVoiceChat: () => void }) {
  const state = useRuntimeWork(threadId);
  const shell = useApp(s => s.threads[threadId]);
  const status = shell?.activityRunStatus ?? shell?.status;
  const running = working || !!shell?.activeRunId || !!activeWork(state) || state.background || !!shell?.pendingRuntimeRequest || ["preparing", "starting", "running", "waiting"].includes(status ?? "");
  if (running) return <StopAllButton threadId={threadId} />;
  if (hasDraft || inVoiceChat) return null;
  return <IconButton onClick={onVoiceChat} className="size-9 bg-pill text-pill-fg hover:bg-pill hover:text-pill-fg hover:opacity-90" title="Start voice chat"><AudioLines size={17} /></IconButton>;
}

// ---------- file viewer ----------
function FileViewer({ bot, threadId, path, onClose, onOpenFile }: { bot: Bot; threadId: string | null; path: string; onClose: () => void; onOpenFile: (path: string) => void }) {
  const validated = workspaceFilePath(path);
  return <WorkspaceFileContext value={{ workspaceRoot: bot.workspaceRoot, threadId, fromPath: validated ?? undefined, openFile: onOpenFile }}>
    <WorkspaceResourceViewer key={path} resource={threadId && validated ? { _tag: "workspace-file", threadId, path: validated } : null} title={validated ?? "File unavailable"} onClose={onClose} renderText={(content) => /\.md$/i.test(path) ? <MessageContent text={content} /> : <pre className="whitespace-pre-wrap">{content}</pre>} />
  </WorkspaceFileContext>;
}
