import { create } from "zustand";
import { columnWidth } from "../lib/layout";
import { writeBoot, type CachedBoot } from "../lib/threadCache";
import type { RoomSummary, RoomView } from "../lib/rooms";
import type { RoutineRecord, RoutineRunRef } from "../lib/routineAlerts";
import type { VaultItem } from "../lib/vault";
import type {
  Bot, DetailsTab, Machine, ModelSelection, ProjectShell, Provider, ProviderModelPreferences,
  Run, RuntimeFeatures, RuntimeRequest, ScheduledTask, Settings, SnoozePreset, Subagent,
  ThreadMeta, ThreadPreview, ThreadShell, TurnItem,
} from "../lib/types";

export type ThreadData = {
  items: Record<string, TurnItem>;
  runs: Record<string, Run>;
  requests: Record<string, RuntimeRequest>;
  subagents: Record<string, Subagent>;
  loaded: boolean;
  /** Painted from this device's own copy; T3's snapshot has not landed yet, so it says nothing about now. */
  stale?: boolean;
  /** The copy was looked for and found empty: what is missing is on the server, not on its way. */
  copyChecked?: boolean;
  /** Bounded snapshots hold only recent rows; older ones load page by page from this cursor. */
  historyCursor?: string | null;
  hasMoreHistory?: boolean;
};

export type MainBotIntent = { kind: "replace" } | { kind: "hide"; slug: string } | { kind: "delete"; slug: string };
export type Dialog = null | "new-bot" | "settings" | "search" | "connect-apps" | { kind: "connect-apps"; url: string } | { kind: "delete-bot"; slug: string } | "adopt-project" | { kind: "rename-bot"; slug: string } | { kind: "computer"; slug: string } | { kind: "main-bot"; intent: MainBotIntent; initialSlug?: string } | { kind: "room"; id?: string } | "mobile";

export type SearchFilter = "All" | "Messages" | "Bots" | "Rooms" | "Routines" | "Files" | "Apps";
export type SearchSession = { query: string; filter: SearchFilter; index: number; scrollTop: number };
export type ToastLink = { href: string; label: string; open?: () => void };
export type BotStatus = "idle" | "working" | "waiting" | "failed" | "unread" | "new" | "done";
export type Attachment = { type: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number; previewUrl?: string; environmentId?: string };

export const PREVIEWS_KEY = "bot.previews";
/** A request to this gateway that has not answered in this long is not going to. */
export const GATEWAY_PATIENCE_MS = 8_000;
export const deadline = (ms: number) => (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

function loadPreviews(): Record<string, ThreadPreview> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREVIEWS_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, ThreadPreview> : {};
  } catch {
    return {};
  }
}

function readRoomSeen(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("threebot.rooms.seen") ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export type State = {
  runtimeFeatures: RuntimeFeatures;
  snoozePresets: SnoozePreset[];
  /** T3's backup for new threads when the default model is out of usage. */
  fallbackModel: ModelSelection | null;
  /** The side chat open beside its parent conversation. */
  sideChat: { parentThreadId: string; threadId: string } | null;
  archiveError: string | null;
  olderSettledCursor: { settledAt: string; threadId?: string } | null;
  archivedThreads: Record<string, ThreadShell>;
  auth: "unknown" | "loading" | "access" | "password" | "error" | "ready";
  connection: "connecting" | "open" | "closed";
  /** This page opened from what the device kept, or lost a socket it had: what is on screen is the last copy. */
  offline: boolean;
  /** The open room is the copy this device kept; its live sync has not answered yet. */
  roomStale: boolean;
  /** This device has no copy of the open room: what is missing is on the server, not on its way. */
  roomMissing: boolean;
  /** The gateway says the open room is gone (deleted on another device); its copy must not come back. */
  roomGone: boolean;
  /** One short line for the live region: only state changes say anything, never the first paint. */
  announcement: string;
  botsRoot: string;
  executorUrl: string | null;
  settings: Settings | null;
  bots: Record<string, Bot>;
  historicalBots: Record<string, Bot>;
  projects: Record<string, ProjectShell>;
  threads: Record<string, ThreadShell>;
  /** Roster lines from the gateway, cached here so home paints before it answers. */
  previews: Record<string, ThreadPreview>;
  threadMeta: Record<string, ThreadMeta>;
  providers: Provider[];
  /** T3's per-provider hidden models and model order (`server.getConfig().settings`). */
  providerModelPreferences: ProviderModelPreferences;
  /** Model picker favorites, kept in this browser. */
  tasks: ScheduledTask[];
  /** Per-routine ownership and alert choices, shared by every device through the gateway. */
  routineAlerts: Record<string, RoutineRecord>;
  /** The newest observed conversation per task, from the gateway's persisted refs. */
  routineRuns: Record<string, RoutineRunRef>;
  /** A run-ref read failed for this task; the list must not present the old ref as current. */
  routineRunsStale: Record<string, boolean>;
  threadData: Record<string, ThreadData>;
  selected: string | null;
  selectedThreadId: string | null;
  exchangeBotSlug: string | null;
  detailsOpen: boolean;
  sidebarCompact: boolean;
  sidebarWidth: number;
  detailsWidth: number;
  detailsTab: DetailsTab;
  dialog: Dialog;
  searchSession: SearchSession;
  searchResultRevision: number;
  settingsPane: string;
  toast: string | null;
  /** A link shown after the toast's text, such as release notes. `open` handles it in the app instead. */
  toastLink: ToastLink | null;
  page: "projects" | "map" | "room" | null;
  projectItemId: string | null;
  /** Rooms: summaries for the sidebar, and the open room view. */
  rooms: Record<string, RoomSummary>;
  roomView: RoomView | null;
  selectedRoom: string | null;
  roomError: string | null;
  /** When this browser last opened each room; drives the sidebar's unread dot. */
  roomSeen: Record<string, string>;
  /** The Vault without passwords (null until loaded). */
  vault: VaultItem[] | null;
  /** Settings → Machines: this machine first, then the ones T3 links or Threebot reaches directly. Null until loaded. */
  machines: Machine[] | null;
};

export const useApp = create<State>(() => ({
  runtimeFeatures: { shellOlderSettled: false, threadFind: false, threadResumeCompletionMarker: false, sideChats: false, threadForceStop: false, voiceTranscription: false, freshContext: false, scheduledTaskThreadModes: false },
  snoozePresets: [],
  fallbackModel: null,
  sideChat: null,
  archiveError: null,
  olderSettledCursor: null,
  archivedThreads: {},
  auth: "unknown",
  connection: "closed",
  offline: false,
  roomStale: false,
  roomMissing: false,
  roomGone: false,
  announcement: "",
  botsRoot: "",
  executorUrl: null,
  settings: null,
  bots: {},
  historicalBots: {},
  projects: {},
  threads: {},
  previews: loadPreviews(),
  threadMeta: {},
  providers: [],
  providerModelPreferences: {},
  tasks: [],
  routineAlerts: {},
  routineRuns: {},
  routineRunsStale: {},
  threadData: {},
  selected: localStorage.getItem("bot.selected"),
  selectedThreadId: null,
  exchangeBotSlug: null,
  detailsOpen: localStorage.getItem("bot.details") !== "0",
  sidebarCompact: localStorage.getItem("bot.sidebar.compact") === "1",
  sidebarWidth: columnWidth("sidebar", localStorage.getItem("bot.sidebar.width")),
  detailsWidth: columnWidth("details", localStorage.getItem("bot.details.width")),
  detailsTab: "details",
  dialog: null,
  searchSession: { query: "", filter: "All", index: 0, scrollTop: 0 },
  searchResultRevision: 0,
  settingsPane: "general",
  toast: null,
  toastLink: null,
  page: null,
  projectItemId: null,
  rooms: {},
  roomView: null,
  selectedRoom: null,
  roomError: null,
  roomSeen: readRoomSeen(),
  vault: null,
  machines: null,
}));

export const set = useApp.setState;
export const get = useApp.getState;

/** Shared mutable coordination state across slices. */
export const storeShared = {
  /** This launch painted a copy before asking: the one thing that makes an offline claim honest later. */
  copied: false,
  /** Signing out is the last write: nothing on screen may be saved after it. */
  forgetting: false,
  botsRevision: 0,
  pendingBotMutations: 0,
  /** A write pending per conversation, so a streaming turn saves at most once a second instead of per frame. */
  cacheTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  /** Conversations deleted while this page was open: a late frame must not save them back. */
  forgottenThreads: new Set<string>(),
  /** The shell intentionally omits idle children. Retain families fetched for open conversations across reconnect snapshots. */
  familyThreadIds: new Set<string>(),
  /** Threads a room reads in full. Their copy keeps less: the room shows the recent turns. */
  roomThreads: new Set<string>(),
  /** Which room a member conversation belongs to, so the room's deletion takes its copy (former members too). */
  roomOfThread: new Map<string, string>(),
  /** Rooms deleted while this page was open: a list fetched before the deletion must not name them. */
  deletedRooms: new Set<string>(),
};

/** What the next launch needs when the gateway cannot be reached. Best effort: a full quota changes nothing here. */
export function keepBoot(boot: Omit<CachedBoot, "v" | "savedAt">) {
  void writeBoot(boot);
}
