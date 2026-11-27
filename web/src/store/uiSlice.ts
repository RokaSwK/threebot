import { columnWidth, type Column } from "../lib/layout";
import { t3 } from "../lib/t3";
import { get, set, useApp, type Dialog, type ToastLink } from "./context";
import { stopRoomPoll } from "./roomsSlice";

export function select(slug: string | null) {
  stopRoomPoll();
  set({ selected: slug, selectedThreadId: null, exchangeBotSlug: null, page: null, projectItemId: null, selectedRoom: null, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null });
  if (slug) localStorage.setItem("bot.selected", slug);
  const bot = slug ? get().bots[slug] : null;
  if (bot?.mainThreadId) t3.dispatch({ type: "thread.visit", threadId: bot.mainThreadId, visitedAt: new Date().toISOString() }).catch(() => {});
}

export function openExchange(otherSlug: string | null) {
  if (otherSlug && !get().bots[otherSlug] && !get().historicalBots[otherSlug]) return;
  set({ exchangeBotSlug: otherSlug });
}

export function setDetailsOpen(open: boolean) {
  set({ detailsOpen: open });
  localStorage.setItem("bot.details", open ? "1" : "0");
}

export function setSidebarCompact(compact: boolean) {
  set({ sidebarCompact: compact });
  localStorage.setItem("bot.sidebar.compact", compact ? "1" : "0");
}

export function setColumnWidth({ column, width, persist = true }: { column: Column; width: number; persist?: boolean }) {
  const next = columnWidth(column, width);
  set(column === "sidebar" ? { sidebarWidth: next } : { detailsWidth: next });
  if (persist) localStorage.setItem(`bot.${column}.width`, String(next));
}

/** Settings → Beta → Projects board. Off until the settings say otherwise. */
export const useProjectsOn = () => useApp((s) => s.settings?.beta?.projects === true);

/** Open the Projects page, optionally on one item. */
export function openProjects(itemId: string | null = null) {
  set({ page: "projects", projectItemId: itemId, exchangeBotSlug: null, dialog: null });
}

export function openBotMap() {
  set({ page: "map", projectItemId: null, exchangeBotSlug: null, dialog: null, detailsOpen: false });
}

export function openDialog(dialog: Dialog) {
  set({ dialog });
}

export function toast(msg: string, link: ToastLink | null = null) {
  set({ toast: msg, toastLink: link });
  window.setTimeout(() => get().toast === msg && set({ toast: null, toastLink: null }), msg.length > 80 || link ? 12_000 : 3500);
}
