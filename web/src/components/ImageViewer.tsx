import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { workspaceAssetUrl } from "../lib/workspaceAssets";
import type { LibraryResource } from "../lib/workspaceLinks";
import { workspaceClient } from "../lib/workspaceTransport";
import "./ImageViewer.css";

/** One image the viewer can show: a signed T3 resource (signed afresh on view and on Open/Download) or a remote https URL. */
export type ViewerImage = { key: string; alt: string; resource?: LibraryResource; download?: LibraryResource; src?: string; name?: string };

type Gallery = { register: (element: HTMLElement, image: ViewerImage) => () => void; open: (element: HTMLElement) => void };
const MessageImagesContext = createContext<Gallery | null>(null);

/** Groups the images of one chat message, in document order, so the viewer can move between them. */
export function MessageImages({ children }: { children: ReactNode }) {
  const parent = useContext(MessageImagesContext);
  const images = useRef(new Map<HTMLElement, ViewerImage>());
  const [open, setOpen] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const gallery = useMemo<Gallery>(() => ({
    register: (element, image) => { images.current.set(element, image); return () => { images.current.delete(element); }; },
    open: (element) => {
      const list = [...images.current].filter(([node]) => node.isConnected)
        .sort(([a], [b]) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      setOpen({ images: list.map(([, image]) => image), index: Math.max(0, list.findIndex(([node]) => node === element)) });
    },
  }), []);
  if (parent) return children;
  return <MessageImagesContext value={gallery}>{children}{open && <ImageViewer images={open.images} initialIndex={open.index} onClose={() => setOpen(null)} />}</MessageImagesContext>;
}

/** Register a tappable image with its message's gallery (or show it alone when there is none). */
export function useOpenImage(image: ViewerImage | null) {
  const gallery = useContext(MessageImagesContext);
  // A state ref: the thumbnail may mount after the image is known (once its signed URL arrives).
  const [element, ref] = useState<HTMLElement | null>(null);
  const [alone, setAlone] = useState(false);
  const imageKey = image ? JSON.stringify(image) : null;
  const latest = useRef(image);
  latest.current = image;
  useEffect(() => {
    if (!gallery || !element || !latest.current) return;
    return gallery.register(element, latest.current);
  }, [gallery, element, imageKey]);
  const open = useCallback(() => {
    if (gallery && element) gallery.open(element); else setAlone(true);
  }, [gallery, element]);
  const viewer = alone && image ? <ImageViewer images={[image]} initialIndex={0} onClose={() => setAlone(false)} /> : null;
  return { ref, open, viewer };
}

type View = { scale: number; x: number; y: number };
const REST: View = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

async function signedUrl(resource: LibraryResource, scopeThreadId: string | null) {
  if (resource._tag === "workspace-file") workspaceClient(resource.threadId);
  const url = await workspaceAssetUrl(resource, scopeThreadId);
  if (!url.startsWith("/t3/")) throw new Error("Invalid asset response");
  return url;
}

/**
 * Full-screen image viewer. Zoom by pinch, double-tap, wheel or trackpad; pan by dragging; swipe or arrow keys
 * between images; close with Esc, ✕, a backdrop tap or Back (it owns one history entry while open).
 */
export function ImageViewer({ images, initialIndex, onClose, scopeThreadId = null }: { images: ViewerImage[]; initialIndex: number; onClose: () => void; scopeThreadId?: string | null }) {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), images.length - 1));
  const image = images[index];
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ready"; url: string }>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>(REST);
  const [gesturing, setGesturing] = useState(false);
  const [actionError, setActionError] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const close = useRef(onClose);
  close.current = onClose;
  const many = images.length > 1;

  // Back closes the viewer: it pushes one entry and closes when that entry is popped. Closing any other way pops it.
  // The token survives StrictMode's effect replay, so development does not push twice or close itself.
  const entry = useRef<{ token: string; timer?: number } | null>(null);
  useEffect(() => {
    if (entry.current?.timer !== undefined) { window.clearTimeout(entry.current.timer); entry.current.timer = undefined; }
    if (!entry.current || history.state?.imageViewer !== entry.current.token) {
      entry.current = { token: Math.random().toString(36).slice(2) };
      history.pushState({ ...(history.state ?? {}), imageViewer: entry.current.token }, "");
    }
    const current = entry.current;
    const onPop = () => { if (history.state?.imageViewer !== current.token) close.current(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      current.timer = window.setTimeout(() => { if (history.state?.imageViewer === current.token) history.back(); });
    };
  }, []);
  const requestClose = useCallback(() => {
    if (entry.current && history.state?.imageViewer === entry.current.token) history.back(); else close.current();
  }, []);

  const go = useCallback((step: number) => {
    if (!many) return;
    setIndex((value) => (value + step + images.length) % images.length);
  }, [many, images.length]);

  useEffect(() => { setView(REST); setActionError(false); }, [index]);

  // Sign the shown image afresh: signed URLs expire, and the inline copy may be old.
  const resourceKey = JSON.stringify(image.resource ?? null);
  useEffect(() => {
    if (!image.resource) { setState(image.src ? { kind: "ready", url: image.src } : { kind: "error" }); return; }
    let live = true;
    setState({ kind: "loading" });
    signedUrl(image.resource, scopeThreadId).then((url) => { if (live) setState({ kind: "ready", url }); }).catch(() => { if (live) setState({ kind: "error" }); });
    return () => { live = false; };
  }, [resourceKey, image.src, attempt, scopeThreadId]);

  // Focus, Escape, arrows and a Tab trap, only while this is the top dialog.
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLElement>("[data-viewer-close]")?.focus();
    const top = () => Array.from(document.querySelectorAll("[data-bot-modal]")).at(-1) === panel.current;
    const onKey = (event: KeyboardEvent) => {
      if (!top()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); requestClose(); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); go(event.key === "ArrowLeft" ? -1 : 1); }
      else if (event.key === "Tab") {
        const list = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
        const first = list[0]; const last = list.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [go, requestClose]);

  /** Keep the zoomed image covering the stage instead of sliding away. */
  const clamp = useCallback((next: View): View => {
    const scale = Math.min(Math.max(next.scale, 1), MAX_SCALE);
    if (scale <= 1.001) return REST;
    const box = stage.current?.getBoundingClientRect();
    const width = picture.current?.offsetWidth ?? 0; const height = picture.current?.offsetHeight ?? 0;
    if (!box) return { scale, x: next.x, y: next.y };
    const maxX = Math.max(0, (width * scale - box.width) / 2); const maxY = Math.max(0, (height * scale - box.height) / 2);
    return { scale, x: Math.min(Math.max(next.x, -maxX), maxX), y: Math.min(Math.max(next.y, -maxY), maxY) };
  }, []);
  /** Zoom to `scale` keeping the image point under (clientX, clientY) in place. */
  const zoomAt = useCallback((from: View, scale: number, clientX: number, clientY: number): View => {
    const box = stage.current?.getBoundingClientRect();
    const px = box && Number.isFinite(clientX) ? clientX - box.left - box.width / 2 : 0; const py = box && Number.isFinite(clientY) ? clientY - box.top - box.height / 2 : 0;
    const ratio = Math.min(Math.max(scale, 1), MAX_SCALE) / from.scale;
    return clamp({ scale, x: px - (px - from.x) * ratio, y: py - (py - from.y) * ratio });
  }, [clamp]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // React's wheel listener is passive; zooming must stop the page from scrolling.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const from = viewRef.current;
      setView(zoomAt(from, from.scale * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "drag"; x: number; y: number; from: View; moved: boolean; onImage: boolean } | { kind: "pinch"; distance: number; mid: { x: number; y: number }; from: View } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const [swipe, setSwipe] = useState(0);
  const pinchStart = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = { kind: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, from: viewRef.current };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setGesturing(true);
    if (pointers.current.size === 2) pinchStart();
    else if (pointers.current.size === 1) gesture.current = { kind: "drag", x: event.clientX, y: event.clientY, from: viewRef.current, moved: false, onImage: event.target === picture.current };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current;
    if (current?.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = current.from.scale * Math.hypot(a.x - b.x, a.y - b.y) / current.distance;
      const box = stage.current?.getBoundingClientRect();
      const cx = box ? box.left + box.width / 2 : 0; const cy = box ? box.top + box.height / 2 : 0;
      const ratio = Math.min(Math.max(scale, 1), MAX_SCALE) / current.from.scale;
      setView(clamp({ scale, x: mid.x - cx - (current.mid.x - cx - current.from.x) * ratio, y: mid.y - cy - (current.mid.y - cy - current.from.y) * ratio }));
    } else if (current?.kind === "drag") {
      const dx = event.clientX - current.x; const dy = event.clientY - current.y;
      if (Math.hypot(dx, dy) > 6) current.moved = true;
      if (current.from.scale > 1) setView(clamp({ scale: current.from.scale, x: current.from.x + dx, y: current.from.y + dy }));
      else if (many && Math.abs(dx) > Math.abs(dy)) setSwipe(dx);
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (pointers.current.size === 1) { const [rest] = [...pointers.current.values()]; gesture.current = { kind: "drag", x: rest.x, y: rest.y, from: viewRef.current, moved: true, onImage: false }; return; }
    if (pointers.current.size > 1) { pinchStart(); return; }
    gesture.current = null; setGesturing(false); setSwipe(0);
    if (current?.kind !== "drag" || event.type === "pointercancel") return;
    const dx = event.clientX - current.x; const dy = event.clientY - current.y;
    if (current.moved) {
      if (current.from.scale <= 1 && many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) go(dx < 0 ? 1 : -1);
      return;
    }
    if (!current.onImage) { requestClose(); return; }
    const now = event.timeStamp || Date.now();
    const previous = lastTap.current;
    if (previous && now - previous.at < 320 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 30) {
      lastTap.current = null;
      setView(viewRef.current.scale > 1 ? REST : zoomAt(viewRef.current, DOUBLE_TAP_SCALE, event.clientX, event.clientY));
    } else lastTap.current = { at: now, x: event.clientX, y: event.clientY };
  };

  /** Open or download with a URL signed now: the one on screen may have expired. */
  const act = async (mode: "open" | "download") => {
    setActionError(false);
    if (!image.resource) { if (image.src) window.open(image.src, "_blank", "noopener,noreferrer"); return; }
    // Open the tab inside the click so pop-up blockers allow it, then point it at the fresh URL.
    const tab = mode === "open" ? window.open("", "_blank") : null;
    try {
      const url = await signedUrl(mode === "download" ? image.download ?? image.resource : image.resource, scopeThreadId);
      if (mode === "open") {
        if (tab) { tab.opener = null; tab.location.href = url; } else window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      const link = document.createElement("a");
      link.href = url; link.download = image.name ?? image.alt ?? "image"; link.hidden = true;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    } catch {
      tab?.close();
      setActionError(true);
    }
  };

  const label = image.alt || image.name || "Image";
  return createPortal(
    <div ref={panel} data-bot-modal role="dialog" aria-modal="true" aria-label={`Image viewer: ${label}`} tabIndex={-1} className="image-viewer">
      <div className="image-viewer-bar">
        <span className="image-viewer-count" aria-live="polite">{many ? `${index + 1} / ${images.length}` : ""}</span>
        <button type="button" className="image-viewer-button" onClick={() => void act("open")} aria-label="Open original" title="Open original"><ExternalLink size={18} aria-hidden="true" /></button>
        {image.resource && <button type="button" className="image-viewer-button" onClick={() => void act("download")} aria-label="Download" title="Download"><Download size={18} aria-hidden="true" /></button>}
        <button type="button" data-viewer-close className="image-viewer-button" onClick={requestClose} aria-label="Close" title="Close"><X size={20} aria-hidden="true" /></button>
      </div>
      <div ref={stage} className="image-viewer-stage" data-zoomed={view.scale > 1 ? "" : undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {state.kind === "loading" && <p role="status" className="image-viewer-note">Loading image…</p>}
        {state.kind === "error" && <div role="alert" className="image-viewer-note"><p>Couldn't open this image. It may be unavailable or access may have expired.</p><button type="button" className="image-viewer-retry" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>}
        {state.kind === "ready" && <img ref={picture} key={state.url} src={state.url} alt={image.alt} draggable={false} className="image-viewer-image" data-gesturing={gesturing ? "" : undefined}
          style={{ transform: `translate3d(${view.x + swipe}px, ${view.y}px, 0) scale(${view.scale})` }} onError={() => setState({ kind: "error" })} />}
        {many && <>
          <button type="button" className="image-viewer-button image-viewer-nav" data-side="prev" onClick={() => go(-1)} aria-label="Previous image" title="Previous image"><ChevronLeft size={22} aria-hidden="true" /></button>
          <button type="button" className="image-viewer-button image-viewer-nav" data-side="next" onClick={() => go(1)} aria-label="Next image" title="Next image"><ChevronRight size={22} aria-hidden="true" /></button>
        </>}
      </div>
      {(image.alt || actionError) && <p className="image-viewer-caption">{actionError ? "Couldn't get the original. Try again." : image.alt}</p>}
    </div>, document.body,
  );
}
