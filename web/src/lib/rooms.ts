import { apiRequest } from "./api";
import type { ModelSelection } from "./types";

/** A room member as the API reports it: a Bot plus the thread created for this room. */
export type MemberView = {
  slug: string;
  name: string;
  label: string;
  color: string;
  shape: string;
  avatarImage: string | null;
  threadId: string | null;
  status: "pending" | "ready" | "unavailable";
  model: unknown;
  runtimeMode: string;
  lastTurnAt: string | null;
  /** A member that left the room: its thread is kept for history, never addressed. */
  removed?: boolean;
};

export type RoomTurnStatus = "queued" | "running" | "done" | "stopped" | "interrupted" | "failed";
export type RoomRun = {
  slug: string;
  runId: string | null;
  late?: boolean;
  status?: "replied" | "passed" | "no-reply" | "failed" | "timeout" | "stopped";
  error?: string;
  at?: string;
};
export type RoomTurn = {
  id: string;
  at: string;
  text: string;
  mentions: string[];
  replyTo: string | null;
  status: RoomTurnStatus;
  runs: RoomRun[];
};

export type RoomMode = "panel" | "roundtable";
export type RoomRuntimeMode = "inherit" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type RoomMentionPolicy = "anywhere" | "leading";
export type RoomDefaultResponder = "lead" | "everyone" | "mentions";

export type RoomSettings = {
  mode: RoomMode;
  defaultResponder: RoomDefaultResponder;
  lead: string;
  runtimeMode: RoomRuntimeMode;
  model: "inherit" | ModelSelection;
  mentionPolicy: RoomMentionPolicy;
  allowCrossMentions: boolean;
  maxWaves: number;
  maxReplies: number;
  memberTimeoutMin: number;
  turnDeadlineMin: number;
  notifications: boolean;
};

export type RoomSummary = {
  id: string;
  name: string;
  description: string;
  section: string | null;
  pinned: boolean;
  mode: RoomMode;
  members: MemberView[];
  lastTurnAt: string | null;
  /** The newest user message or member reply; used for ordering and the unread dot. */
  lastActivityAt: string | null;
  /** A one-line preview of the last user message (or the room's description). */
  lastText: string;
  queued: number;
  running: boolean;
};

export type RoomView = {
  id: string;
  name: string;
  description: string;
  guidance: string;
  section: string | null;
  pinned: boolean;
  createdAt: string;
  settings: RoomSettings;
  members: MemberView[];
  formerMembers: MemberView[];
  turns: RoomTurn[];
};

/** Defaults from `docs/designs/rooms.md`. `lead` is filled with the first member on create. */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  mode: "panel",
  defaultResponder: "lead",
  lead: "",
  runtimeMode: "inherit",
  model: "inherit",
  mentionPolicy: "anywhere",
  allowCrossMentions: true,
  maxWaves: 3,
  maxReplies: 10,
  memberTimeoutMin: 10,
  turnDeadlineMin: 20,
  notifications: true,
};

export type CreateRoomInput = {
  name: string;
  description?: string;
  guidance?: string;
  members: string[];
  settings?: Partial<RoomSettings>;
  /** Sidebar organization; both are accepted on create. */
  pinned?: boolean;
  section?: string | null;
};

export type UpdateRoomInput = {
  name?: string;
  description?: string;
  guidance?: string;
  section?: string | null;
  pinned?: boolean;
  members?: string[];
  settings?: Partial<RoomSettings>;
};

export type SendRoomMessageInput = {
  text: string;
  mentions?: string[];
  replyTo?: string | null;
};

export type DeleteRoomResult = {
  ok: true;
  threads: { deleted: number; failed: { threadId: string; error: string }[] };
};

const roomPath = (id: string) => `/api/rooms/${encodeURIComponent(id)}`;

export function fetchRooms(): Promise<RoomSummary[]> {
  return apiRequest<{ rooms: RoomSummary[] }>("/api/rooms").then((body) => body.rooms);
}

export function fetchRoom(id: string): Promise<RoomView> {
  return apiRequest<{ room: RoomView }>(roomPath(id)).then((body) => body.room);
}

export function createRoom(input: CreateRoomInput): Promise<RoomView> {
  return apiRequest<{ room: RoomView }>("/api/rooms", { method: "POST", body: JSON.stringify(input) }).then((body) => body.room);
}

export function updateRoom(id: string, input: UpdateRoomInput): Promise<RoomView> {
  return apiRequest<{ room: RoomView }>(roomPath(id), { method: "PATCH", body: JSON.stringify(input) }).then((body) => body.room);
}

export function deleteRoom(id: string): Promise<DeleteRoomResult> {
  return apiRequest<DeleteRoomResult>(roomPath(id), { method: "DELETE", body: "{}" });
}

export function recreateRoom(id: string, slug?: string): Promise<RoomView> {
  return apiRequest<{ room: RoomView }>(`${roomPath(id)}/recreate`, { method: "POST", body: JSON.stringify(slug ? { slug } : {}) }).then((body) => body.room);
}

export function sendRoomMessage(id: string, input: SendRoomMessageInput): Promise<RoomTurn> {
  return apiRequest<{ turn: RoomTurn }>(`${roomPath(id)}/messages`, { method: "POST", body: JSON.stringify(input) }).then((body) => body.turn);
}

export function stopRoom(id: string): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>(`${roomPath(id)}/stop`, { method: "POST", body: "{}" });
}
