import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, Check, Hand, Monitor, Plus, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { IconButton, Spinner } from "./ui";
import { botStatus, openDialog, useApp } from "../store";
import { browserStreamUrl, closeBrowser, openBrowser, profileLabel, watchBrowser, type BrowserState } from "../lib/previewApi";
import { threadTarget } from "../lib/t3";
import type { Bot } from "../lib/types";

// The Bot's computer: T3's headless browser on the server, streamed as JPEG frames over
// /api/preview-stream/ws. Watching is read-only; "Take control" forwards mouse and keys.

export function useBrowser(threadId: string | null | undefined) {
  const [result, setResult] = useState<{ target: string; state: BrowserState } | null>(null);
  const refresh = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!threadId) return;
    const watcher = watchBrowser(threadId, state => setResult({ target: threadId, state }));
    refresh.current = watcher.refresh;
    return () => { refresh.current = null; watcher.dispose(); };
  }, [threadId]);
  const state: BrowserState = result && result.target === threadId ? result.state : { kind: "loading" };
  return { state, refresh: () => refresh.current?.() };
}

/** Compatibility entry point for the Details thumbnail. No timers or control claims. */
export function useBotTabs(threadId: string | null | undefined) {
  const { state } = useBrowser(threadId);
  return state.kind === "loading" ? null : state.index?.tabs.filter(tab => tab.runtime === "server") ?? [];
}

const MODIFIERS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"] as const;

type ComputerControl = { canOperate: boolean; controller: "agent" | "you" | "another-viewer" | "unclaimed" };
type Point = { x: number; y: number; scaleX: number; scaleY: number };
type MouseButton = typeof BUTTONS[number];
type Click = { button: MouseButton; pointerType: string; time: number; x: number; y: number; count: number };
type Press = { id: number; touch: boolean; startX: number; startY: number; lastX: number; lastY: number; panning: boolean; point: Point; buttons: number; clicks: Record<MouseButton, number> };
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const TEXT_LIMIT = 10_000; // ServerBrowser dispatchViewerInput limits each text message in UTF-16 units.
const CONTROL_KEYS = [{ key: "Enter", code: "Enter", keyCode: 13 }, { key: "Backspace", code: "Backspace", keyCode: 8 }, { key: "Tab", code: "Tab", keyCode: 9 }, { key: "Escape", code: "Escape", keyCode: 27 }] as const;

export function ComputerScreen({ threadId, tabId, interactive, url = "", className, onControl }: { threadId: string; tabId: string; interactive: boolean; url?: string; className?: string; onControl?: (control: ComputerControl | null) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const viewport = useRef({ width: 1280, height: 800 });
  const ownership = useRef<ComputerControl | null>(null);
  const press = useRef<Press | null>(null);
  const lastClick = useRef<Click | null>(null);
  const keys = useRef(new Map<string, { key: string; code: string; keyCode: number }>());
  const lastMove = useRef(0);
  const controlCallback = useRef(onControl);
  controlCallback.current = onControl;
  const [control, setControl] = useState<ComputerControl | null>(null);
  const [text, setText] = useState("");
  const [address, setAddress] = useState(url);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const textHintId = useId();
  const [state, setState] = useState<"connecting" | "live" | "gone" | "error">("connecting");
  const [failure, setFailure] = useState("Couldn't connect to the browser");
  const [attempt, setAttempt] = useState(0);
  const canInput = interactive && control?.canOperate === true && control.controller === "you";
  useEffect(() => { setAddress(url); setAddressError(null); }, [threadId, tabId, url]);
  const send = (message: Record<string, unknown>) => {
    if (!interactive || !ownership.current?.canOperate || ownership.current.controller !== "you" || ws.current?.readyState !== WebSocket.OPEN) return false;
    try {
      ws.current.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };
  const queueText = (value: string) => {
    if (!value || value.length > TEXT_LIMIT) return false;
    const queued = send({ type: "text", text: value });
    setTextError(queued ? null : "Text wasn't sent. Take control of the computer and try again.");
    return queued;
  };
  const countClick = (event: React.PointerEvent, button: MouseButton) => {
    const last = lastClick.current;
    const elapsed = last ? event.timeStamp - last.time : -1;
    const count = last && last.button === button && last.pointerType === event.pointerType && elapsed >= 0 && elapsed < MULTI_CLICK_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < MULTI_CLICK_SLOP_PX ? last.count + 1 : 1;
    lastClick.current = { button, pointerType: event.pointerType, time: event.timeStamp, x: event.clientX, y: event.clientY, count };
    return count;
  };
  const releasePress = (resetClicks = false) => {
    const held = press.current;
    press.current = null;
    if (!held) return;
    if (resetClicks) lastClick.current = null;
    for (const [bit, button] of [[1, "left"], [2, "right"], [4, "middle"]] as const) {
      if (!(held.buttons & bit)) continue;
      held.buttons &= ~bit;
      send({ type: "mouse", action: "up", x: held.point.x, y: held.point.y, button, buttons: held.buttons, clickCount: held.clicks[button], modifiers: 0 });
    }
  };
  const releaseKeys = () => {
    for (const held of keys.current.values()) send({ type: "key", action: "up", ...held, modifiers: 0 });
    keys.current.clear();
  };

  useEffect(() => {
    setState("connecting"); setControl(null); ownership.current = null; lastClick.current = null;
    controlCallback.current?.(null);
    const socket = new WebSocket(browserStreamUrl(threadId, tabId, interactive));
    socket.binaryType = "blob";
    ws.current = socket;
    let stopped = false;
    let lastUrl: string | null = null;
    let pendingUrl: string | null = null;
    let requested = false;
    socket.onmessage = (ev) => {
      if (stopped) return;
      if (typeof ev.data === "string") {
        try {
          const message: unknown = JSON.parse(ev.data);
          if (!message || typeof message !== "object") return;
          if ("type" in message && message.type === "viewport" && "width" in message && "height" in message && typeof message.width === "number" && typeof message.height === "number" && Number.isFinite(message.width) && Number.isFinite(message.height) && message.width > 0 && message.height > 0) viewport.current = { width: message.width, height: message.height };
          if ("type" in message && message.type === "control" && "canOperate" in message && typeof message.canOperate === "boolean" && "controller" in message && (message.controller === "you" || message.controller === "agent" || message.controller === "another-viewer" || message.controller === "unclaimed")) {
            const next: ComputerControl = { canOperate: message.canOperate, controller: message.controller };
            ownership.current = next; setControl(next); controlCallback.current?.(next);
            if (next.controller !== "you" || !next.canOperate) { press.current = null; keys.current.clear(); lastClick.current = null; }
            if (interactive && next.canOperate && next.controller !== "you" && !requested) {
              requested = true;
              socket.send(JSON.stringify({ type: "takeControl" }));
            }
          }
        } catch { /* Ignore unknown stream metadata. */ }
        return;
      }
      const el = img.current;
      if (!el || !(ev.data instanceof Blob)) return;
      const url = URL.createObjectURL(ev.data);
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      pendingUrl = url;
      el.onload = () => {
        if (stopped || pendingUrl !== url) return;
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url; pendingUrl = null;
        setState("live");
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ack" }));
      };
      el.src = url;
    };
    socket.onclose = (ev) => {
      if (stopped) return;
      ownership.current = null; setControl(null); controlCallback.current?.(null);
      press.current = null; keys.current.clear(); lastClick.current = null;
      setFailure(ev.code === 4403 ? "This connection cannot watch or control this browser." : ev.code === 4503 ? "The browser host needs setup in T3." : "Couldn't connect to the browser");
      setState(ev.code === 4404 ? "gone" : "error");
    };
    return () => {
      releasePress(true); releaseKeys(); lastClick.current = null;
      if (interactive && ownership.current?.controller === "you" && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: "releaseControl" })); } catch { /* Disconnect also releases viewer ownership on T3. */ }
      }
      stopped = true; ownership.current = null;
      socket.close();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    };
  }, [threadId, tabId, interactive, attempt]);

  // The image element fills the viewer; object-contain centers the actual JPEG inside it.
  // JPEG dimensions may differ from the page's CSS viewport, so use each independently.
  const point = (clientX: number, clientY: number): Point | null => {
    const el = img.current;
    if (!el || !el.naturalWidth || !el.naturalHeight) return null;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(rect.width / el.naturalWidth, rect.height / el.naturalHeight);
    const width = el.naturalWidth * ratio, height = el.naturalHeight * ratio;
    if (width <= 0 || height <= 0) return null;
    const x = clientX - rect.left - (rect.width - width) / 2;
    const y = clientY - rect.top - (rect.height - height) / 2;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    return { x: Math.min(viewport.current.width - 1, Math.round(x / width * viewport.current.width)), y: Math.min(viewport.current.height - 1, Math.round(y / height * viewport.current.height)), scaleX: viewport.current.width / width, scaleY: viewport.current.height / height };
  };
  const mouse = (action: "down" | "up" | "move", at: Point, button: string, buttons: number, modifiers: number, clickCount = 1) => send({ type: "mouse", action, x: at.x, y: at.y, button, buttons, clickCount, modifiers });
  const pointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!canInput || !event.isPrimary || press.current) return;
    const at = point(event.clientX, event.clientY);
    if (!at) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const touch = event.pointerType === "touch";
    const button = BUTTONS[event.button] ?? "left";
    const clicks = { left: 1, middle: 1, right: 1 };
    if (!touch) clicks[button] = countClick(event, button);
    press.current = { id: event.pointerId, touch, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, panning: false, point: at, buttons: touch ? 0 : event.buttons & 7, clicks };
    if (!touch) {
      event.currentTarget.focus({ preventScroll: true });
      mouse("down", at, button, event.buttons & 7, MODIFIERS(event), clicks[button]);
    }
  };
  const pointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!canInput || !event.isPrimary) return;
    const held = press.current;
    if (held && held.id !== event.pointerId) return;
    const at = point(event.clientX, event.clientY);
    if (held && Math.hypot(event.clientX - held.startX, event.clientY - held.startY) >= MULTI_CLICK_SLOP_PX) {
      lastClick.current = null;
      if (!held.touch) held.panning = true;
    }
    if (held?.touch) {
      event.preventDefault();
      if (!held.panning && Math.hypot(event.clientX - held.startX, event.clientY - held.startY) < 6) return;
      held.panning = true;
      if (at) send({ type: "wheel", x: at.x, y: at.y, deltaX: (held.lastX - event.clientX) * at.scaleX, deltaY: (held.lastY - event.clientY) * at.scaleY, modifiers: 0 });
      held.lastX = event.clientX; held.lastY = event.clientY;
      return;
    }
    if (!at || event.pointerType === "touch") return;
    const now = performance.now();
    if (!held && now - lastMove.current < 40) return;
    lastMove.current = now;
    if (held) {
      const changed = held.buttons ^ (event.buttons & 7);
      for (const [bit, button] of [[1, "left"], [2, "right"], [4, "middle"]] as const) {
        if (!(changed & bit)) continue;
        held.buttons ^= bit;
        if (held.buttons & bit) held.clicks[button] = countClick(event, button);
        mouse(held.buttons & bit ? "down" : "up", at, button, held.buttons, MODIFIERS(event), held.clicks[button]);
      }
      held.point = at;
    }
    mouse("move", at, "none", held?.buttons ?? 0, MODIFIERS(event), 0);
  };
  const pointerEnd = (event: React.PointerEvent<HTMLImageElement>) => {
    const held = press.current;
    if (!held || held.id !== event.pointerId) return;
    const at = point(event.clientX, event.clientY);
    if (!held.touch) { if (at) held.point = at; releasePress(event.type !== "pointerup" || !at || held.panning); }
    else {
      press.current = null;
      if (event.type !== "pointerup" || held.panning || !at) { lastClick.current = null; return; }
      const clickCount = countClick(event, "left");
      mouse("move", at, "none", 0, 0, 0); mouse("down", at, "left", 1, 0, clickCount); mouse("up", at, "left", 0, 0, clickCount);
    }
  };
  const key = (action: "down" | "up") => (event: React.KeyboardEvent) => {
    if (!canInput) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    const held = { key: event.key, code: event.code, keyCode: event.keyCode };
    if (action === "down") keys.current.set(event.code, held); else keys.current.delete(event.code);
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    send({ type: "key", action, ...held, ...(printable && action === "down" ? { text: event.key } : {}), modifiers: MODIFIERS(event) });
  };
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (!canInput) return;
      const at = point(event.clientX, event.clientY);
      if (!at) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current.height : 1;
      send({ type: "wheel", x: at.x, y: at.y, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: MODIFIERS(event) });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  return (
    <div className={clsx("relative flex flex-col overflow-hidden bg-black", className)}>
      {canInput && <form className="flex shrink-0 gap-2 px-3 pb-2" onSubmit={event => {
        event.preventDefault();
        try {
          const next = new URL(address.includes(":") ? address.trim() : `https://${address.trim()}`);
          if (!["http:", "https:"].includes(next.protocol) || next.href.length > 2048 || next.username || next.password) throw new Error("Enter a web address using http or https.");
          setAddressError(send({ type: "navigate", url: next.href }) ? null : "Take control before opening an address.");
        } catch { setAddressError("Enter a web address using http or https."); }
      }}>
        <input aria-label="Browser address" aria-invalid={addressError ? true : undefined} type="text" inputMode="url" autoComplete="off" value={address} onChange={event => setAddress(event.target.value)} placeholder="Enter a web address" className="h-10 min-w-0 flex-1 rounded-full bg-white/10 px-4 text-base text-white outline-none focus:ring-1 focus:ring-white/50" />
        <button type="submit" className="min-h-10 rounded-full bg-white/10 px-4 text-[13px] text-white">Go</button>
      </form>}
      {addressError && <p role="alert" className="shrink-0 px-4 pb-2 text-[13px] text-white/70">{addressError}</p>}
      <div className="relative min-h-0 flex-1">
        <img ref={img} alt="Bot's screen" draggable={false} tabIndex={canInput ? 0 : -1}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={() => releasePress(true)}
          onBlur={() => { releasePress(true); releaseKeys(); lastClick.current = null; }}
          onContextMenu={event => canInput && event.preventDefault()} onKeyDown={key("down")} onKeyUp={key("up")}
          onPaste={event => { if (!canInput) return; event.preventDefault(); const value = event.clipboardData.getData("text"); if (value && !queueText(value)) setText(draft => draft + value); }}
          style={{ touchAction: canInput ? "none" : "auto" }}
          className={clsx("block h-full w-full object-contain outline-none select-none", canInput && "cursor-default", state !== "live" && "opacity-0")} />
        {state !== "live" && <div role="status" className="absolute inset-0 grid place-items-center text-center text-[13px] text-white/70"><div>{state === "connecting" ? <Spinner size={18} /> : state === "gone" ? "This page was closed" : failure}{state === "error" && <button type="button" className="mx-auto mt-4 block rounded-full bg-white/10 px-4 py-2" onClick={() => setAttempt(value => value + 1)}>Reconnect browser</button>}</div></div>}
      </div>
      {interactive && (canInput || text.length > 0 || textError) && <div className="shrink-0 space-y-2 border-t border-white/15 bg-black p-2 text-[13px]">
        <form className="flex items-start gap-2" onSubmit={event => { event.preventDefault(); if (queueText(text)) setText(""); }}>
          <textarea aria-label="Type on computer" aria-describedby={textHintId} aria-invalid={text.length > TEXT_LIMIT || undefined} placeholder="Tap a field above, then type here" value={text} onChange={event => { setText(event.target.value); setTextError(null); }} rows={2} autoComplete="off" className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-base text-white outline-none focus:ring-1 focus:ring-white/50" />
          <button type="submit" disabled={!canInput || !text || text.length > TEXT_LIMIT} className="rounded-lg bg-white px-3 py-2 text-black disabled:opacity-40">Send</button>
        </form>
        <p id={textHintId} role={text.length > TEXT_LIMIT || textError ? "alert" : undefined} className="text-white/70">{text.length > TEXT_LIMIT ? `${text.length.toLocaleString()} / ${TEXT_LIMIT.toLocaleString()} characters. Shorten the text before sending. Your text is kept here.` : textError ?? (!canInput ? "Take control to send this text." : `${text.length.toLocaleString()} / ${TEXT_LIMIT.toLocaleString()} characters`)}</p>
        <div className="flex gap-2 overflow-x-auto">{CONTROL_KEYS.map(command => <button key={command.key} type="button" disabled={!canInput} className="min-h-9 rounded-lg bg-white/10 px-3 disabled:opacity-40" onClick={() => { send({ type: "key", action: "down", ...command, modifiers: 0 }); send({ type: "key", action: "up", ...command, modifiers: 0 }); }}>{command.key}</button>)}</div>
      </div>}
    </div>
  );
}

/** Shared thumbnail for Details; mounting it is always read-only. */
export function ComputerThumbnail({ bot }: { bot: Bot }) {
  const { state } = useBrowser(bot.mainThreadId);
  const tab = state.kind === "loading" ? null : state.index?.tabs.findLast(tab => tab.runtime === "server");
  return <button type="button" onClick={() => openDialog({ kind: "computer", slug: bot.slug })} className="block w-full overflow-hidden rounded-2xl border border-line bg-card text-left" aria-label={`Open ${bot.name}’s browser`}>
    {tab && bot.mainThreadId ? <ComputerScreen threadId={bot.mainThreadId} tabId={tab.tabId} interactive={false} className="pointer-events-none aspect-[16/10] w-full" /> : <div className="grid aspect-[16/10] place-items-center p-4 text-center text-[13px] text-muted"><div><Monitor size={22} className="mx-auto mb-2 opacity-60" />{state.kind === "loading" ? "Checking browser…" : state.kind === "error" ? "Browser unavailable" : "No browser tabs open"}</div></div>}
  </button>;
}

/** The full-page computer view, backed by T3's browser. */
export function ComputerOverlay({ slug }: { slug: string }) {
  const bot = useApp(s => s.bots[slug]);
  const selected = useApp(s => s.selected === slug ? s.selectedThreadId : null);
  const threadId = selected ?? bot?.mainThreadId;
  if (!bot || !threadId) return null;
  // A changed conversation remounts all local ownership and panel state.
  return <ComputerView key={`${slug}:${threadId}`} bot={bot} threadId={threadId} />;
}

function ComputerView({ bot, threadId }: { bot: Bot; threadId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const { state, refresh } = useBrowser(threadId);
  const [tabId, setTabId] = useState<string | null>(null);
  const [controlTarget, setControlTarget] = useState<string | null>(null);
  const [ownership, setOwnership] = useState<ComputerControl | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useApp(s => botStatus(bot, s));
  const index = state.kind === "loading" ? null : state.index;
  const tabs = index?.tabs.filter(tab => tab.runtime === "server") ?? [];
  const tab = tabs.find(tab => tab.tabId === tabId) ?? tabs.at(-1);
  const streamKey = tab ? JSON.stringify([threadId, index?.serverEpoch, tab.tabId, tab.profileId]) : null;
  const control = streamKey !== null && controlTarget === streamKey && state.kind === "ready";
  const controlling = control && ownership?.canOperate && ownership.controller === "you";
  const close = () => openDialog(null);
  const returnControl = () => { setControlTarget(null); setOwnership(null); };
  useEffect(() => { setControlTarget(null); setOwnership(null); }, [streamKey, state.kind]);
  useEffect(() => {
    const previous = document.activeElement;
    const target = root.current;
    const buttons = () => Array.from(target?.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex="0"]') ?? []).filter(element => !element.matches(':disabled, [hidden]'));
    buttons()[0]?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // While controlling the page, Tab on the streamed image belongs to it.
      if (control && document.activeElement?.tagName === "IMG") return;
      const list = buttons(), first = list[0], last = list.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !target?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !target?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", trap);
    return () => { window.removeEventListener("keydown", trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [control]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || control) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [control]);
  const open = async () => {
    if (pending) return;
    setPending(true); setError(null); returnControl();
    try {
      const opened = await openBrowser(threadId, tab?.profileId ?? undefined);
      setTabId(opened.tabId);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn’t open the browser"); }
    finally { setPending(false); }
  };
  const closeTab = async () => {
    if (!tab || pending) return;
    setPending(true); setError(null); returnControl();
    try { await closeBrowser(threadId, tab.tabId); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn’t close the tab"); }
    finally { setPending(false); }
  };
  const statusText = controlling ? "You're in control" : control ? ownership?.canOperate === false ? "Read-only" : ownership?.controller === "another-viewer" ? "Another viewer has control" : "Requesting control…" : "Watching";
  return <div ref={root} role="dialog" aria-modal="true" aria-label={`${bot.name}’s computer`} className="fixed inset-0 z-50 flex flex-col bg-black text-white" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
    <header className="flex min-h-20 shrink-0 items-center gap-3 px-4 py-4">
      <button type="button" aria-label="Back to conversation" onClick={close} className="grid size-11 shrink-0 place-items-center rounded-full border border-white/15 bg-white/10"><ArrowLeft size={23} /></button>
      <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={28} state={controlling ? "waiting" : status === "working" ? "working" : status === "waiting" ? "waiting" : status === "failed" ? "failed" : "idle"} />
      <span className="min-w-0 flex-1 truncate text-[18px]">{bot.name}</span>
    </header>
    {tab && <div className="flex shrink-0 items-center gap-2 px-4 pb-2 text-[12px] text-white/55">
      <select aria-label="Browser tabs" value={tab.tabId} onChange={event => { returnControl(); setTabId(event.target.value); }} className="h-9 min-w-0 flex-1 truncate rounded-full bg-white/10 px-3 text-white outline-none">
        {tabs.map(tab => <option key={tab.tabId} value={tab.tabId}>{tab.title || tab.url || "New tab"} · {profileLabel(tab.profileId)}</option>)}
      </select>
      <IconButton aria-label="Open browser tab" disabled={pending || state.kind !== "ready"} onClick={() => void open()} className="text-white/70"><Plus size={18} /></IconButton>
      <IconButton aria-label="Close browser tab" disabled={pending || state.kind !== "ready"} onClick={() => void closeTab()} className="text-white/70"><X size={18} /></IconButton>
    </div>}
    <main className="relative flex min-h-0 flex-1 flex-col">
      {state.kind === "error" && <div role="alert" className="shrink-0 bg-white/10 p-3 text-[13px] text-white/75">{state.message}<button type="button" onClick={() => void refresh()} className="ml-3 underline">Retry</button></div>}
      {error && <p role="alert" className="shrink-0 p-3 text-[13px] text-white/75">{error}</p>}
      {tab?.status === "Loading" && <p role="status" className="shrink-0 px-4 py-2 text-[13px] text-white/65">Loading page…</p>}
      {tab?.error && <p role="status" className="shrink-0 break-words px-4 py-2 text-[13px] text-white/65">{tab.download ? `Download started: ${tab.download.fileName}. Downloads can be opened in T3.` : `Page failed to load: ${tab.error}`}</p>}
      {state.kind === "loading" ? <div className="grid flex-1 place-items-center"><Spinner size={20} /></div> : tab ? <ComputerScreen key={`${streamKey}:${control}`} threadId={threadId} tabId={tab.tabId} url={tab.url} interactive={control} onControl={setOwnership} className="min-h-0 flex-1" /> : <div className="grid flex-1 place-items-center px-6 text-center text-[15px] text-white/60"><div><Monitor size={30} className="mx-auto mb-4 opacity-60" /><p>{state.kind === "error" ? "Browser unavailable" : "No browser tabs open"}</p><p className="mx-auto mt-2 max-w-72 text-[13px] leading-5">{index?.tabs.some(tab => tab.runtime !== "server") ? "This Bot has a desktop browser. Watch it in its owning T3 app, or open a server browser here." : "Open a browser for this Bot to watch a page or take control."}</p>{state.kind === "ready" && <button type="button" onClick={() => void open()} disabled={pending} className="mx-auto mt-5 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-white disabled:opacity-40">{pending ? <Spinner size={14} /> : <Plus size={16} />} {pending ? "Opening browser…" : "Open browser"}</button>}</div></div>}
    </main>
    <footer className="flex min-h-20 shrink-0 items-center justify-between gap-3 px-4 py-4">
      <div className="min-w-0 text-[12px] text-white/50"><span role="status">{tab ? statusText : "Browser"}</span>{tab && <span className="block truncate">{profileLabel(tab.profileId)}</span>}{threadTarget(threadId).environmentId && <span className="block">Linked environment</span>}</div>
      {tab ? control ? <button type="button" onClick={returnControl} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white"><Check size={16} />{controlling ? "I'm done" : "Cancel"}</button> : <button type="button" onClick={() => { setOwnership(null); setControlTarget(streamKey); }} disabled={state.kind !== "ready" || pending} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 text-[15px] text-white disabled:opacity-40"><Hand size={16} />Take control</button> : null}
    </footer>
  </div>;
}
