export type Bot = {
  slug: string;
  workspaceRoot: string;
  name: string;
  label: string;
  shape: string;
  color: string;
  avatarImage?: string | null;
  section: string | null;
  pinned: boolean;
  hidden: boolean;
  primary: boolean;
  notifications: boolean;
  projectId: string | null;
  mainThreadId: string | null;
  createdAt: string;
  updatedAt?: string;
  model?: ModelSelection | null;
};

/** The roster line for a conversation, which T3's shell stream leaves empty. */
export type ThreadPreview = { kind: "text" | "attachment" | "question" | "sent"; role: "user" | "assistant"; text: string; at: string | null };

export type ThreadMeta = { reactions: Record<string, string[]>; voiceCalls: { at: string; seconds: number }[] };

export type Settings = {
  userName: string;
  theme: "system" | "light" | "dark";
  palette: "amoled" | "pingbot" | "t3" | "t3-chat" | "grove" | "ocean" | "ember" | "iris";
  accent: "bot" | "black";
  timezone: string;
  autoReview: boolean;
  rules: { alwaysAsk: string[]; allowWithoutAsking: string[] };
  sections: string[];
  defaultModel: ModelSelection | null;
};

export type ProviderOptionSelection = { id: string; value: string | boolean };

export type ModelSelection = {
  instanceId: string;
  model: string;
  options?: ProviderOptionSelection[];
};

export type RunStatus =
  | "idle"
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type ThreadShell = {
  id: string;
  projectId: string;
  title: string;
  status: RunStatus;
  activityRunStatus?: RunStatus | null;
  activeRunId: string | null;
  latestRunId: string | null;
  /** Missing on older servers; explicit null means no completed latest run. */
  latestRunCompletedAt?: string | null;
  latestRunStartedAt?: string | null;
  latestRunRequestedAt?: string | null;
  modelSelection: ModelSelection;
  runtimeMode: string;
  pendingRuntimeRequest: { id: string; kind: string; blocking: boolean } | null;
  latestVisibleMessage: { id: string; role: string; text: string; updatedAt: string } | null;
  latestUserMessageAt: string | null;
  lineage: { parentThreadId: string | null; relationshipToParent: string | null; rootThreadId: string };
  archivedAt: string | null;
  /** Settlement is an inbox lifecycle, independent of the latest run outcome. */
  settledOverride?: "settled" | "active" | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  autoSettleDisabledAt?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
  lastErrorClass?: string | null;
  limitRecovery?: unknown;
  environmentId?: string;
  lastVisitedAt: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Subagent = {
  id: string;
  title: string | null;
  status: string;
  childThreadId: string | null;
  remoteChild?: { threadId: string; environmentId: string; label?: string };
  progress?: string | null;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type ProjectShell = {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  createdAt: string;
  updatedAt: string;
};

export type TurnItem = {
  id: string;
  threadId: string;
  runId: string | null;
  ordinal: number;
  status: string;
  title: string | null;
  type: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  parentItemId: string | null;
  [k: string]: any;
};

export type Run = {
  id: string;
  ordinal: number;
  status: RunStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  modelSelection: ModelSelection;
};

export type RuntimeRequest = {
  id: string;
  kind: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  responseCapability?: { type: string };
};

export type ProviderOptionChoice = { id: string; label: string; description?: string; isDefault?: boolean };

export type ProviderOptionDescriptor =
  | {
      id: string;
      label: string;
      description?: string;
      type: "select";
      options: ProviderOptionChoice[];
      currentValue?: string;
      promptInjectedValues?: string[];
    }
  | { id: string; label: string; description?: string; type: "boolean"; currentValue?: boolean };

export type ProviderModel = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  aliases?: string[];
  isCustom?: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  badge?: "new";
  capabilities?: { optionDescriptors?: ProviderOptionDescriptor[] };
};

export type Provider = {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  status: string;
  accentColor?: string;
  models: ProviderModel[];
};

/** Per provider instance, from T3's `server.getConfig().settings.providerModelPreferences`. */
export type ProviderModelPreferences = Record<string, { hiddenModels: string[]; modelOrder: string[] }>;

export type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule:
    | { type: "interval"; everyMs: number }
    | { type: "fixed_time"; timeOfDay: string; weekdays?: number[] }
    | { type: "webhook"; [k: string]: unknown };
  projectId: string;
  threadId: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  runCount?: number;
};

export type SnoozePreset = { kind: "after"; minutes: number } | { kind: "at"; day: "today" | "tomorrow" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"; time: string };
export type RuntimeFeatures = { shellOlderSettled: boolean; threadFind: boolean; threadResumeCompletionMarker: boolean };
