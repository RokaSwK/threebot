import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, MessageSquareDot, MoreHorizontal, Reply, SmilePlus, TextCursor } from "lucide-react";
import { copyText } from "../lib/t3";
import { markThreadUnread, toggleReaction, toast, useApp } from "../store";
import { MOBILE_CHAT_QUERY } from "../lib/chatBehavior";
import { EmojiPicker } from "./EmojiPicker";
import "./ChatMessageActions.css";

type ActionState = "idle" | "copying" | "copied" | "copy-error" | "marking-unread" | "marked-unread" | "unread-error" | "selection-error";
const QUICK_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮", "🔥", "👀", "🙏", "😢", "💯"];
type Point = { x: number; y: number };

function interactive(target: EventTarget | null) {
  return target instanceof Element && !!target.closest("a,button,input,textarea,select,video,audio,[contenteditable=true]");
}

/** Read the actual rendered message, without its controls or duplicate math
 * trees. Mounting the inert clone lets innerText retain browser block layout. */
function renderedMessageText(body: HTMLElement) {
  if (body.dataset.messageBody === "plain") return body.textContent ?? "";
  const clone = body.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return "";
  for (const math of clone.querySelectorAll(".katex")) {
    const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
    math.replaceWith(document.createTextNode(annotation?.textContent ?? math.querySelector(".katex-html")?.textContent ?? ""));
  }
  for (const control of clone.querySelectorAll('.code-copy-button,.mermaid-toolbar,.mermaid-canvas,[role="toolbar"],input,textarea,select,[role="status"],[role="alert"],[hidden],[aria-hidden="true"],.sr-only,svg,script,style')) control.remove();
  const staging = document.createElement("div");
  staging.setAttribute("aria-hidden", "true"); staging.inert = true;
  staging.style.cssText = "position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;contain:layout style paint;";
  staging.append(clone); document.body.append(staging);
  try { return clone.innerText.trim(); } finally { staging.remove(); }
}

/** Message content stays mounted while actions and native text selection open. */
export function ChatMessageActions({ text, threadId, itemId, runId, onReply, side, children, className = "" }: { text: string; threadId?: string; itemId?: string; runId?: string | null; onReply?: (text: string) => void; side: "user" | "bot"; children: ReactNode; className?: string }) {
  const [position, setPosition] = useState<Point | null>(null);
  const [picking, setPicking] = useState(false);
  const reactions = useApp((s) => threadId && itemId ? s.threadMeta?.[threadId]?.reactions?.[itemId] : undefined);
  const [state, setState] = useState<ActionState>("idle");
  const [selecting, setSelecting] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const operation = useRef<symbol | null>(null);
  const hold = useRef<{ timer: number; point: Point } | null>(null);
  const cancelHold = () => { if (hold.current) window.clearTimeout(hold.current.timer); hold.current = null; };
  const messageBody = () => wrapper.current?.querySelector<HTMLElement>("[data-message-body]");
  const ownsSelection = () => {
    const selection = window.getSelection(), body = messageBody();
    return !!(selection && !selection.isCollapsed && body?.contains(selection.anchorNode) && body.contains(selection.focusNode));
  };

  useEffect(() => {
    setPosition(null); setState("idle"); setSelecting(false); setPicking(false);
    return () => { operation.current = null; cancelHold(); if (ownsSelection()) window.getSelection()?.removeAllRanges(); };
  }, [text, threadId]);
  useEffect(() => {
    if (state !== "copied" && state !== "marked-unread") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (!selecting) return;
    const changed = () => setSelecting(ownsSelection());
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (ownsSelection()) window.getSelection()?.removeAllRanges();
      setSelecting(false); trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("selectionchange", changed);
    window.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("selectionchange", changed); window.removeEventListener("keydown", escape, true); };
  }, [selecting]);
  useEffect(() => {
    if (!position) { setPicking(false); return; }
    copyButton.current?.focus({ preventScroll: true });
    const close = () => setPosition(null);
    const scrolling = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) close(); };
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close(); trigger.current?.focus({ preventScroll: true });
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
        const current = items.findIndex((item) => item === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowUp" ? (current <= 0 ? items.length - 1 : current - 1) : (current + 1) % items.length;
        items[next]?.focus({ preventScroll: true });
      } else if (event.key === "Tab") { close(); trigger.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    const overflow = document.body.style.overflow;
    const mobile = window.matchMedia(MOBILE_CHAT_QUERY).matches;
    if (mobile) document.body.style.overflow = "hidden";
    window.addEventListener("scroll", scrolling, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolling, true); window.removeEventListener("resize", close);
      if (mobile) document.body.style.overflow = overflow;
    };
  }, [position]);

  const copy = async () => {
    if (operation.current) return;
    const token = Symbol(); operation.current = token; setState("copying");
    try {
      const body = messageBody();
      if (!body) throw new Error("Message content unavailable");
      await copyText(renderedMessageText(body));
      if (operation.current !== token) return;
      operation.current = null; setState("copied"); setPosition(null); trigger.current?.focus({ preventScroll: true });
    } catch {
      if (operation.current !== token) return;
      operation.current = null; setState("copy-error");
    }
  };
  const selectText = () => {
    const body = messageBody(), selection = window.getSelection();
    if (!body || !selection) { setState("selection-error"); return; }
    cancelHold(); setState("idle"); setSelecting(true); setPosition(null);
    const range = document.createRange(); range.selectNodeContents(body);
    selection.removeAllRanges(); selection.addRange(range);
  };
  const markUnread = async () => {
    if (!threadId || operation.current) return;
    const token = Symbol(); operation.current = token; setState("marking-unread");
    try {
      await markThreadUnread(threadId);
      if (operation.current !== token) return;
      operation.current = null; setState("marked-unread"); setPosition(null); trigger.current?.focus({ preventScroll: true });
    } catch {
      if (operation.current !== token) return;
      operation.current = null; setState("unread-error");
    }
  };
  const react = (emoji: string) => {
    if (!threadId || !itemId) return;
    setPosition(null);
    toggleReaction(threadId, itemId, emoji).catch(() => toast("Couldn't save your reaction"));
  };
  const reply = () => {
    const body = messageBody();
    setPosition(null);
    onReply?.(body ? renderedMessageText(body) : text);
  };
  const copyRequestId = () => {
    if (!runId) return;
    copyText(runId).then(() => toast("Copied request ID"), () => toast("Couldn't copy request ID"));
    setPosition(null);
  };
  const startHold = (event: PointerEvent<HTMLDivElement>) => {
    cancelHold();
    if (selecting || ownsSelection() || event.pointerType !== "touch" && event.pointerType !== "pen" || interactive(event.target)) return;
    const point = { x: event.clientX, y: event.clientY };
    hold.current = { point, timer: window.setTimeout(() => { hold.current = null; setPosition(point); }, 500) };
  };
  const viewport = window.visualViewport;
  const offsetX = viewport?.offsetLeft ?? 0, offsetY = viewport?.offsetTop ?? 0;
  const left = position ? Math.max(offsetX + 8, Math.min(position.x, offsetX + (viewport?.width ?? window.innerWidth) - 232)) : 0;
  const top = position ? Math.max(offsetY + 8, Math.min(position.y, offsetY + (viewport?.height ?? window.innerHeight) - (threadId ? 330 : 150))) : 0;
  const pending = state === "copying" || state === "marking-unread";
  // Resize dismisses the menu, so its next open uses the current input layout.
  const mobile = typeof window.matchMedia === "function" && window.matchMedia(MOBILE_CHAT_QUERY).matches;
  const confirmed = state === "copied" || state === "marked-unread";
  const feedback = state === "copied" ? "Message copied." : state === "copying" ? "Copying message…" : state === "marked-unread" ? "Conversation marked as unread." : state === "marking-unread" ? "Marking conversation unread…" : selecting ? "Message text selected. Use your browser's text actions." : "";
  const close = () => { setPosition(null); trigger.current?.focus({ preventScroll: true }); };

  const reactionChips = reactions?.length ? <div className="chat-reactions" role="group" aria-label="Reactions">{reactions.map((emoji) => <button key={emoji} type="button" aria-pressed="true" aria-label={`You reacted with ${emoji}. Remove your ${emoji} reaction`} onClick={() => react(emoji)}>{emoji}</button>)}</div> : null;
  if (!text.length) return <div className={className}>{children}{reactionChips}</div>;
  return <div ref={wrapper} className={`chat-message-actions ${className}`} data-side={side} data-actions-open={!!position} data-selecting={selecting} data-mobile={mobile}
    onCopy={(event) => {
      const selection = window.getSelection(), body = messageBody();
      if (!selection || !body || !ownsSelection()) return;
      const selected = document.createElement("div");
      const anchorPre = selection.anchorNode?.parentElement?.closest("pre");
      const focusPre = selection.focusNode?.parentElement?.closest("pre");
      if (body.dataset.messageBody === "plain" || anchorPre && anchorPre === focusPre) selected.dataset.messageBody = "plain";
      for (let index = 0; index < selection.rangeCount; index++) selected.append(selection.getRangeAt(index).cloneContents());
      event.clipboardData.setData("text/plain", renderedMessageText(selected)); event.preventDefault();
    }}
    onContextMenu={(event) => { if (!selecting && !ownsSelection() && !interactive(event.target)) { event.preventDefault(); cancelHold(); setPosition({ x: event.clientX, y: event.clientY }); } }}
    onPointerDown={startHold}
    onPointerMove={(event) => { const point = hold.current?.point; if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10) cancelHold(); }}
    onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold}>
    {children}
    {reactionChips}
    <button ref={trigger} type="button" className="chat-message-action-trigger" aria-label="Message actions" aria-haspopup="menu" aria-expanded={!!position}
      onClick={() => { if (ownsSelection()) window.getSelection()?.removeAllRanges(); setSelecting(false); const rect = trigger.current?.getBoundingClientRect(); setPosition(position ? null : { x: rect?.left ?? 8, y: rect?.bottom ?? 8 }); }}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    <span role="status" className={confirmed || state === "marking-unread" ? "chat-message-copy-feedback" : "sr-only"}>{feedback}</span>
    {position && createPortal(<>
    <div className="chat-message-action-backdrop" data-mobile={mobile} onPointerDown={(event) => event.stopPropagation()} onClick={close} />
    <div ref={menu} role="menu" aria-label="Message actions" data-mobile={mobile} className="chat-message-action-menu" style={mobile ? undefined : { left, top }}>
      <button type="button" className="chat-message-sheet-dismiss" aria-label="Close message actions" onClick={close}><span aria-hidden="true" /></button>
      {picking ? <EmojiPicker onBack={() => setPicking(false)} onPick={react} /> : <>
      {threadId && itemId && <div role="group" aria-label="Reactions" className="chat-reaction-grid">
        {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" aria-pressed={!!reactions?.includes(emoji)} aria-label={reactions?.includes(emoji) ? `Remove ${emoji} reaction` : `React with ${emoji}`} onClick={() => react(emoji)}>{emoji}</button>)}
        <button type="button" aria-label="More emoji" onClick={() => setPicking(true)}><SmilePlus size={21} aria-hidden="true" /></button>
      </div>}
      {threadId && <div role="group" aria-label="Conversation actions" className="chat-message-action-group">
        {onReply && <button type="button" role="menuitem" disabled={pending} onClick={reply}><Reply size={20} aria-hidden="true" />Reply</button>}
        <button type="button" role="menuitem" aria-label={state === "unread-error" ? "Retry marking conversation as unread" : "Mark conversation as unread"} disabled={pending} onClick={markUnread}>
        <MessageSquareDot size={20} aria-hidden="true" />
        {state === "marking-unread" ? "Marking as unread…" : state === "unread-error" ? "Retry mark as unread" : "Mark as unread"}
      </button></div>}
      <div role="group" aria-label="Message text actions" className="chat-message-action-group">
      <button ref={copyButton} type="button" role="menuitem" aria-label="Copy message" disabled={pending} onClick={copy}>
        {state === "copied" ? <Check size={20} aria-hidden="true" /> : <Copy size={20} aria-hidden="true" />}
        {state === "copying" ? "Copying…" : "Copy"}
      </button>
      <button type="button" role="menuitem" disabled={pending} onClick={selectText}><TextCursor size={20} aria-hidden="true" />Select Text</button>
      {runId && <button type="button" role="menuitem" disabled={pending} onClick={copyRequestId}><Copy size={20} aria-hidden="true" />Copy Request ID</button>}
      </div>
      </>}
      {state === "copy-error" && <p role="alert">Couldn't copy message. Try again.</p>}
      {state === "unread-error" && <p role="alert">Couldn't mark conversation as unread. Try again.</p>}
      {state === "selection-error" && <p role="alert">Text selection isn't available in this browser.</p>}
    </div></>, document.body)}
  </div>;
}
