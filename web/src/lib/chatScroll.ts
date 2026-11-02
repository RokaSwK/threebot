import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { Entry } from "./transcript";

type Offset = { top: number; left: number };
type ContentOffset = Offset & { entryId: string; path: number[]; tag: string };
type View = { top: number; followLatest: boolean; content: Map<string, ContentOffset>; visibleCount: number; entryCount: number };

const HISTORY_BATCH = 20;

// View state belongs to the conversation, including when Chat is unmounted.
// Keep DOM nodes out of this cache so leaving a conversation releases its tree.
const views = new Map<string, View>();
function viewFor(threadKey: string) {
  let view = views.get(threadKey);
  if (!view) {
    view = { top: 0, followLatest: true, content: new Map(), visibleCount: HISTORY_BATCH, entryCount: 0 };
    views.set(threadKey, view);
  }
  return view;
}

function contentOffset(target: HTMLElement, scroller: HTMLElement): ContentOffset | null {
  const entry = target.closest<HTMLElement>("[data-chat-entry]");
  const entryId = entry?.getAttribute("data-chat-entry");
  if (!entry || !entryId || !scroller.contains(entry)) return null;
  const path: number[] = [];
  let element: Element = target;
  while (element !== entry) {
    const parent = element.parentElement;
    if (!parent) return null;
    path.unshift(Array.from(parent.children).indexOf(element));
    element = parent;
  }
  return { entryId, path, tag: target.tagName, top: target.scrollTop, left: target.scrollLeft };
}

export function useChatScroll({ threadKey, loaded, entries }: { threadKey: string; loaded: boolean; entries: readonly Entry[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const view = useMemo(() => viewFor(threadKey), [threadKey]);
  const active = useRef<{ key: string; view: View; loaded: boolean; restoring: boolean; height: number; viewportHeight: number; anchoring: string } | null>(null);
  const written = useRef(new WeakMap<HTMLElement, Offset>());
  const [showJump, setShowJump] = useState(!view.followLatest);
  const [, refreshHistory] = useState(0);
  const prepend = useRef<{ key: string; top: number; height: number } | null>(null);
  // Keep the oldest displayed entry when new content arrives. Initial snapshots
  // start at the latest batch; unrelated shell updates never expand history.
  if (loaded) {
    if (view.entryCount > view.visibleCount && entries.length > view.entryCount) view.visibleCount += entries.length - view.entryCount;
    view.entryCount = entries.length;
  }
  const hiddenCount = Math.max(0, entries.length - view.visibleCount);
  const visibleEntries = useMemo(() => entries.slice(hiddenCount), [entries, hiddenCount]);

  const write = (element: HTMLElement, top: number, left = element.scrollLeft) => {
    if (element.scrollTop === top && element.scrollLeft === left) return;
    element.scrollTop = top;
    element.scrollLeft = left;
    // Browsers clamp offsets and dispatch scroll asynchronously. Ignore that
    // event rather than replacing the saved position with a loading clamp.
    written.current.set(element, { top: element.scrollTop, left: element.scrollLeft });
  };
  const restore = () => {
    const current = active.current;
    const element = scroller.current;
    if (!current?.loaded || !element) return;
    current.height = element.scrollHeight;
    current.viewportHeight = element.clientHeight;
    if (current.view.followLatest) write(element, element.scrollHeight);
    else if (current.restoring) write(element, current.view.top);
    if (!current.restoring || !current.view.content.size) return;
    const entries = new Map(Array.from(element.querySelectorAll<HTMLElement>("[data-chat-entry]")).map((entry) => [entry.getAttribute("data-chat-entry"), entry]));
    for (const offset of current.view.content.values()) {
      let target: Element | undefined = entries.get(offset.entryId);
      for (const index of offset.path) target = target?.children.item(index) ?? undefined;
      if (target instanceof HTMLElement && target.tagName === offset.tag) write(target, offset.top, offset.left);
    }
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    const current = { key: threadKey, view, loaded, restoring: true, height: element?.scrollHeight ?? 0, viewportHeight: element?.clientHeight ?? 0, anchoring: element?.style.overflowAnchor ?? "" };
    active.current = current;
    const revealSearch = () => {
      current.restoring = false;
      current.view.followLatest = false;
      setShowJump(true);
    };
    element?.addEventListener("chat-search-reveal", revealSearch);
    // Browser anchoring must not fight restoration while images/layout settle.
    if (element && !view.followLatest) element.style.overflowAnchor = "none";
    setShowJump(!view.followLatest);
    restore();
    const content = scroller.current?.querySelector(".chat-messages");
    const observer = new ResizeObserver(() => { if (active.current === current) restore(); });
    if (content) observer.observe(content);
    if (scroller.current) observer.observe(scroller.current);
    return () => {
      observer.disconnect();
      element?.removeEventListener("chat-search-reveal", revealSearch);
      if (element) element.style.overflowAnchor = current.anchoring;
      if (active.current === current) active.current = null;
    };
  }, [threadKey, view, loaded]);

  // Streaming text and status updates may change height without changing the
  // number of entries. Readers away from the bottom keep their position.
  useLayoutEffect(() => {
    const pending = prepend.current;
    const element = scroller.current;
    if (pending && pending.key === threadKey && element) {
      prepend.current = null;
      view.top = pending.top + element.scrollHeight - pending.height;
      write(element, view.top);
    }
    restore();
  }, [entries, hiddenCount]);

  const loadEarlier = () => {
    const element = scroller.current;
    if (!element || !hiddenCount) return;
    onUserScrollIntent();
    view.followLatest = false;
    setShowJump(true);
    prepend.current = { key: threadKey, top: element.scrollTop, height: element.scrollHeight };
    view.visibleCount += HISTORY_BATCH;
    refreshHistory((revision) => revision + 1);
  };

  const onUserScrollIntent = () => {
    const current = active.current;
    const element = scroller.current;
    if (!current?.loaded || current.key !== threadKey || !element) return;
    current.restoring = false;
    element.style.overflowAnchor = current.anchoring;
    current.view.top = element.scrollTop;
    current.view.followLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    setShowJump(!current.view.followLatest);
  };

  const onScrollCapture = (event: UIEvent<HTMLDivElement>) => {
    const current = active.current;
    const element = scroller.current;
    const target = event.target;
    if (!current?.loaded || current.key !== threadKey || !element || !(target instanceof HTMLElement)) return;
    const expected = written.current.get(target);
    written.current.delete(target);
    if (expected && target.scrollTop === expected.top && target.scrollLeft === expected.left) return;
    if (target === element) {
      // A shrinking transcript can clamp scrollTop before ResizeObserver runs.
      // That is layout, not a new reading position chosen by the user.
      if (current.restoring && (current.height !== element.scrollHeight || current.viewportHeight !== element.clientHeight)) { restore(); return; }
      onUserScrollIntent();
    } else {
      const offset = contentOffset(target, element);
      if (offset) current.view.content.set(JSON.stringify([offset.entryId, offset.path]), offset);
    }
  };
  return { scroller, showJump, onScrollCapture, onUserScrollIntent, visibleEntries, hiddenCount, loadEarlier };
}
