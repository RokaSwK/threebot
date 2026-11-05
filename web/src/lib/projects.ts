// The Projects board in the browser: one snapshot, then a live stream of every change made by
// the user (on any device) or by a Bot. Saves are sent to the gateway and confirmed by the stream.
import { create } from "zustand";

export const KINDS = ["project", "task", "machine", "service", "repo", "note", "link"] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES: Record<Kind, string[]> = {
  project: ["active", "paused", "idea", "done"],
  task: ["todo", "doing", "waiting", "done"],
  machine: ["online", "offline", "unknown"],
  service: ["running", "stopped", "failing", "unknown"],
  repo: ["active", "archived"],
  note: [],
  link: [],
};
export const KIND_LABEL: Record<Kind, string> = { project: "Project", task: "To-do", machine: "Machine", service: "Service", repo: "Repo", note: "Note", link: "Link" };
export const STATUS_LABEL: Record<string, string> = {
  active: "Active", paused: "Paused", idea: "Idea", done: "Done",
  todo: "To do", doing: "Doing", waiting: "Waiting",
  online: "Online", offline: "Offline", unknown: "Unknown",
  running: "Running", stopped: "Stopped", failing: "Failing", archived: "Archived",
};
export const PRIORITIES = ["high", "normal", "low"] as const;

export type Actor = { type: "user" } | { type: "bot"; name?: string; slug?: string };
export type BoardLink =
  | { type: "thread"; threadId: string; environmentId?: string; label?: string }
  | { type: "bot"; slug: string; label?: string }
  | { type: "item"; id: string; label?: string }
  | { type: "url"; url: string; label?: string }
  | { type: "t3project"; projectId: string; environmentId?: string; label?: string };
export type ItemFields = { url?: string; path?: string; host?: string; port?: number; branch?: string; due?: string; priority?: (typeof PRIORITIES)[number]; owner?: string; tags?: string[] };
export type BoardItem = {
  id: string;
  kind: Kind;
  title: string;
  status?: string;
  area?: string;
  parentId?: string;
  machineId?: string;
  body?: string;
  fields: ItemFields;
  links: BoardLink[];
  pinned: boolean;
  order?: number;
  archived: boolean;
  doneAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  updatedBy: Actor;
};
export type Activity = { seq: number; at: string; actor: Actor; itemId: string; kind: Kind; title: string; action: "created" | "updated" | "completed" | "archived" | "restored" | "deleted"; changed: string[] };
/** What a save sends: any subset of an item. null clears a property. */
export type ItemInput = Partial<Omit<BoardItem, "fields" | "parentId" | "machineId" | "order" | "area" | "body" | "status">> & {
  ref?: string;
  area?: string | null;
  body?: string | null;
  status?: string | null;
  parentId?: string | null;
  machineId?: string | null;
  order?: number | null;
  fields?: { [K in keyof ItemFields]?: ItemFields[K] | null };
  addLinks?: BoardLink[];
  removeLinks?: BoardLink[];
};

type ChangeEvent = { version: number; items: BoardItem[]; removed: string[]; activity: Activity[] };

export type Flash = { who: string; at: number };
type BoardState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  version: number;
  items: Record<string, BoardItem>;
  activity: Activity[];
  live: boolean;
  /** Items another person or Bot just changed, so the page can point at them. */
  flashes: Record<string, Flash>;
};

export const useBoard = create<BoardState>(() => ({ status: "idle", error: null, version: 0, items: {}, activity: [], live: false, flashes: {} }));
const set = useBoard.setState;
const get = useBoard.getState;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
  return body as T;
}

export const boardApi = {
  snapshot: () => request<{ version: number; items: BoardItem[]; activity: Activity[] }>("/api/projects"),
  save: (items: ItemInput[]) => request<{ version: number; items: BoardItem[] }>("/api/projects/items", { method: "POST", body: JSON.stringify({ items }) }),
  remove: (ids: string[]) => request<{ version: number; removed: string[] }>("/api/projects/delete", { method: "POST", body: JSON.stringify({ ids }) }),
};

export const actorName = (actor: Actor | undefined) => (!actor || actor.type === "user" ? "You" : actor.name || actor.slug || "A Bot");

const FLASH_MS = 2600;
function flash(ids: string[], who: string) {
  if (!ids.length) return;
  const at = Date.now();
  set((s) => ({ flashes: { ...s.flashes, ...Object.fromEntries(ids.map((id) => [id, { who, at }])) } }));
  setTimeout(() => set((s) => ({ flashes: Object.fromEntries(Object.entries(s.flashes).filter(([, f]) => Date.now() - f.at < FLASH_MS)) })), FLASH_MS + 50);
}

/** Apply one change from the stream. A gap in versions means something was missed: reload. */
export function applyChange(event: ChangeEvent) {
  const s = get();
  if (event.version <= s.version) return;
  if (s.status === "ready" && event.version !== s.version + 1) { void reload(); return; }
  const items = { ...s.items };
  for (const item of event.items) items[item.id] = item;
  for (const id of event.removed) delete items[id];
  set({ items, version: event.version, activity: [...s.activity, ...event.activity].slice(-200) });
  const byBots = event.activity.filter((entry) => entry.actor.type === "bot");
  if (byBots.length) flash(byBots.map((entry) => entry.itemId), actorName(byBots[0].actor));
}

let loading: Promise<void> | null = null;
async function reload() {
  if (loading) return loading;
  loading = (async () => {
    if (get().status !== "ready") set({ status: "loading", error: null });
    try {
      // Changes can arrive while the request is out; a snapshot older than them would erase them.
      let snap = await boardApi.snapshot();
      // A server whose version went back (a restart, a restored file) still wins after a few tries.
      for (let tries = 1; snap.version < get().version && tries < 3; tries++) snap = await boardApi.snapshot();
      set({ status: "ready", error: null, version: snap.version, items: Object.fromEntries(snap.items.map((item) => [item.id, item])), activity: snap.activity });
    } catch (error) {
      if (get().status !== "ready") set({ status: "error", error: error instanceof Error ? error.message : "Couldn't load the board" });
    }
  })().finally(() => { loading = null; });
  return loading;
}

let source: EventSource | null = null;
let users = 0;
/** Follow the board while a page that shows it is open. Returns a function to stop following. */
export function followBoard() {
  users += 1;
  if (!source && typeof EventSource !== "undefined") {
    source = new EventSource("/api/projects/events");
    source.addEventListener("open", () => set({ live: true }));
    source.addEventListener("error", () => set({ live: false }));
    // The stream says which version it follows; anything else means changes were missed while away.
    source.addEventListener("hello", (event) => {
      set({ live: true });
      try { if (JSON.parse((event as MessageEvent).data).version !== get().version) void reload(); } catch { void reload(); }
    });
    source.addEventListener("change", (event) => {
      try { applyChange(JSON.parse((event as MessageEvent).data)); } catch { void reload(); }
    });
  }
  if (get().status === "idle" || get().status === "error") void reload();
  return () => {
    users -= 1;
    if (users <= 0 && source) { source.close(); source = null; users = 0; set({ live: false }); }
  };
}

/** Load the board once, for places that only show a title (an item link in chat). */
export function ensureBoard() {
  if (get().status === "idle") void reload();
}

/** Save changes. The returned items land at once; the stream confirms the same version. */
export async function saveItems(inputs: ItemInput[]) {
  const result = await boardApi.save(inputs);
  // The stream may already have brought this version or a newer one; then the reply is stale.
  set((s) => result.version <= s.version ? {} : { items: { ...s.items, ...Object.fromEntries(result.items.map((item) => [item.id, item])) } });
  return result.items;
}

export async function deleteItems(ids: string[]) {
  const result = await boardApi.remove(ids);
  set((s) => {
    const items = { ...s.items };
    for (const id of result.removed) delete items[id];
    return { items };
  });
}

// ---------- reading the board ----------

const byOrder = (a: BoardItem, b: BoardItem) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt.localeCompare(b.createdAt);
const priorityRank = (item: BoardItem) => PRIORITIES.indexOf(item.fields.priority ?? "normal");
const TASK_STATUS_RANK: Record<string, number> = { doing: 0, todo: 1, waiting: 2, done: 3 };

export function sortTasks(tasks: BoardItem[]) {
  return [...tasks].sort((a, b) =>
    (TASK_STATUS_RANK[a.status ?? "todo"] ?? 1) - (TASK_STATUS_RANK[b.status ?? "todo"] ?? 1)
    || priorityRank(a) - priorityRank(b)
    || (a.fields.due ?? "9999").localeCompare(b.fields.due ?? "9999")
    || byOrder(a, b));
}

export function sortItems(items: BoardItem[]) {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || byOrder(a, b));
}

export function inArea(item: BoardItem, area: string | null, items: Record<string, BoardItem>) {
  if (!area) return true;
  // An item without its own area takes its project's.
  for (let at: BoardItem | undefined = item, steps = 0; at && steps < 20; at = at.parentId ? items[at.parentId] : undefined, steps++) {
    if (at.area) return at.area === area;
  }
  return false;
}

export function matchesSearch(item: BoardItem, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [item.title, item.body, item.area, item.status, KIND_LABEL[item.kind], ...(item.fields.tags ?? []), item.fields.url, item.fields.path, item.fields.host, item.fields.branch].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => hay.includes(word));
}

export function areasOf(items: BoardItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) if (item.area && !item.archived) counts.set(item.area, (counts.get(item.area) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([area]) => area);
}

export function childrenOf(items: BoardItem[], id: string) {
  return items.filter((item) => item.parentId === id && !item.archived);
}

export function isOpenTask(item: BoardItem) {
  return item.kind === "task" && item.status !== "done" && !item.archived;
}

/** Today in the user's own calendar, for due dates. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function dueLabel(due: string | undefined, now = new Date()) {
  if (!due) return null;
  const t = today(now);
  const days = Math.round((Date.parse(`${due}T00:00:00`) - Date.parse(`${t}T00:00:00`)) / 86_400_000);
  const tone = days < 0 ? "late" : days <= 1 ? "soon" : "later";
  const text = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : days < 0 ? `${-days} days late` : days < 7 ? new Date(`${due}T00:00:00`).toLocaleDateString([], { weekday: "long" }) : new Date(`${due}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  return { text, tone } as const;
}

export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function activityText(entry: Activity) {
  const verb = { created: "added", updated: "changed", completed: "finished", archived: "archived", restored: "restored", deleted: "deleted" }[entry.action];
  return `${actorName(entry.actor)} ${verb} ${entry.kind === "task" ? "to-do" : KIND_LABEL[entry.kind].toLowerCase()} “${entry.title}”`;
}

// ---------- links ----------

const ITEM_ID = /^[a-z0-9]{4,24}$/;

/** The link that opens an item in this app, for chat and for Bots. */
export function itemUrl(id: string, base = typeof location === "undefined" ? "" : `${location.origin}${location.pathname}`) {
  return `${base}?item=${encodeURIComponent(id)}`;
}

/** A board item link (absolute on this app, or relative), or null. */
export function parseItemLink(href: string, origin = typeof location === "undefined" ? "" : location.origin): string | null {
  let url: URL;
  try { url = new URL(href, origin || "http://local.invalid"); } catch { return null; }
  if (origin && url.origin !== origin && !/^\/?\?/.test(href)) return null;
  const id = url.searchParams.get("item");
  return id && ITEM_ID.test(id) ? id : null;
}

/** A message a Bot can act on, pointing at the item by link. */
export function askAboutText(item: BoardItem) {
  const what = item.kind === "task" ? "this to-do" : `this ${KIND_LABEL[item.kind].toLowerCase()}`;
  return `About ${what}: [${item.title}](${itemUrl(item.id)}) `;
}

export const SETUP_REQUEST = [
  "Set up my Projects board, please.",
  "- Add my machines (check t3_environment_links) and what runs on each: services with ports and addresses, and the repos checked out there.",
  "- Add the projects I'm working on, split into work and personal, with the open to-dos you know about.",
  "- Link the threads that belong to each project.",
  "Tell me what you added and what you couldn't work out.",
].join("\n");
