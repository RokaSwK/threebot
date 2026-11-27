import { revokeAssetHandles } from "../lib/assetCopies";
import { clearRoomDraft } from "../lib/roomDrafts";
import {
  createRoom as createRoomApi, deleteRoom as deleteRoomApi, fetchRoom, fetchRooms,
  resetRoom as resetRoomApi, sendRoomMessage as sendRoomMessageApi, stopRoom as stopRoomApi,
  updateRoom as updateRoomApi, type CreateRoomInput, type RoomSummary, type RoomTurn,
  type RoomView, type UpdateRoomInput,
} from "../lib/rooms";
import { deletedRecords, forgetRoom, readRoom, readRooms, writeRoom, writeRooms } from "../lib/threadCache";
import { deadline, GATEWAY_PATIENCE_MS, get, set, storeShared, useApp, type Attachment } from "./context";
import { forgetThreadCopy } from "./threadsSlice";

export function noteRoomMembers(room: RoomView) {
  for (const member of [...(room.members ?? []), ...(room.formerMembers ?? [])]) {
    if (typeof member.threadId === "string" && member.threadId) storeShared.roomOfThread.set(member.threadId, room.id);
  }
}

export function stopRoomPoll() {
  // Room updates arrive via /api/events SSE; kept for callers that clean up on navigation.
}

/**
 * The sidebar's room list: what this device kept answers first, the gateway refreshes behind it.
 * A phone that cannot reach the network does not hold the list until a request times out.
 */
export async function loadRooms() {
  await hydrateRooms();
  const fetched = await fetchRooms(deadline(GATEWAY_PATIENCE_MS)).catch(() => null);
  if (!fetched) return Object.values(get().rooms);
  // A list fetched before a room was deleted (in this tab or another) must not bring it back.
  const tombstoned = await deletedRecords(fetched.map((room) => `room:${room.id}`));
  const list = fetched.filter((room) => !storeShared.deletedRooms.has(room.id) && !tombstoned.has(`room:${room.id}`));
  set({ rooms: Object.fromEntries(list.map((room) => [room.id, room])) });
  void writeRooms(list);
  return list;
}

/** Paints the kept list once, before any request: a cold start with no network still names the rooms. */
export async function hydrateRooms() {
  if (Object.keys(get().rooms).length) return;
  const saved = await readRooms().catch(() => null);
  if (!saved || Object.keys(get().rooms).length) return;
  // Another tab may have deleted a room after this list was saved.
  const gone = await deletedRecords(saved.map((room) => `room:${room.id}`));
  const kept = saved.filter((room) => !gone.has(`room:${room.id}`) && !storeShared.deletedRooms.has(room.id));
  if (Object.keys(get().rooms).length) return;
  set({ rooms: Object.fromEntries(kept.map((room) => [room.id, room])) });
}

/** Everything the room view renders; an identical room must not replace the object. */
function roomFingerprint(room: RoomView): string {
  return [
    room.name,
    room.description,
    room.section ?? "",
    String(room.pinned),
    JSON.stringify(room.settings),
    room.members.map((member) => `${member.slug}:${member.threadId}:${member.status}:${member.lastTurnAt}`).join(","),
    (room.formerMembers ?? []).map((member) => `${member.slug}:${member.threadId}`).join(","),
    room.turns.map((turn) => `${turn.id}:${turn.status}:${turn.runs.map((run) => `${run.slug}:${run.runId}:${run.status ?? ""}:${run.late ?? ""}`).join("+")}`).join(","),
  ].join("|");
}

function roomActivity(room: RoomView): string | null {
  return [
    room.turns.at(-1)?.at ?? null,
    ...room.members.map((member) => member.lastTurnAt),
  ].filter((at): at is string => !!at).sort().at(-1) ?? null;
}

function summaryPatch(room: RoomView, existing: RoomSummary): RoomSummary {
  const lastTurn = room.turns.at(-1);
  return {
    ...existing,
    id: room.id,
    name: room.name,
    description: room.description,
    section: room.section,
    pinned: room.pinned,
    mode: room.settings.mode,
    members: room.members,
    lastTurnAt: lastTurn?.at ?? existing.lastTurnAt,
    lastActivityAt: roomActivity(room) ?? existing.lastActivityAt,
    lastText: lastTurn?.text.slice(0, 80) ?? room.description,
    queued: room.turns.filter((turn) => turn.status === "queued").length,
    running: room.turns.some((turn) => turn.status === "running"),
  };
}

export function markRoomSeen(id: string) {
  const roomSeen = { ...get().roomSeen, [id]: new Date().toISOString() };
  try { localStorage.setItem("threebot.rooms.seen", JSON.stringify(roomSeen)); } catch { /* private mode */ }
  set({ roomSeen });
}

export async function loadRoom(id: string, quiet = false) {
  try {
    const room = await fetchRoom(id, deadline(GATEWAY_PATIENCE_MS));
    if (get().selectedRoom !== id) return;
    // An answer that left before the room was found deleted is older than the deletion.
    if (storeShared.deletedRooms.has(id) || get().roomGone || (await deletedRecords([`room:${id}`])).size) return;
    if (get().selectedRoom !== id || storeShared.deletedRooms.has(id) || get().roomGone) return;
    const previous = get().roomView?.id === id ? get().roomView : null;
    noteRoomMembers(room);
    // An identical room must not re-render the page.
    // A saved copy is always replaced by the first live answer: its fingerprint does not cover everything it shows.
    if (previous && !get().roomStale && roomFingerprint(previous) === roomFingerprint(room)) {
      if (!quiet && get().roomError) set({ roomError: null });
      return;
    }
    set((s) => ({
      roomView: room,
      roomStale: false,
      roomMissing: false,
      roomGone: false,
      roomError: null,
      // Keep the sidebar row in step without another list request.
      rooms: s.rooms[room.id] ? { ...s.rooms, [room.id]: summaryPatch(room, s.rooms[room.id]) } : s.rooms,
    }));
    // A reply that arrives while the room is open has been seen; leaving the room must not mark
    // the row unread for something the user just read.
    if (get().selectedRoom === id) markRoomSeen(id);
    void writeRoom(room);
  } catch (error) {
    if (get().selectedRoom !== id) return;
    // Deleted on another device: the copy is not a way back in, and retrying will not bring it back.
    if ((error as { status?: number })?.status === 404 && !get().roomGone) {
      stopRoomPoll();
      void forgetRoomCopy(id);
      set((s) => {
        const rooms = { ...s.rooms };
        delete rooms[id];
        return { rooms, roomView: null, roomStale: false, roomMissing: false, roomGone: true, roomError: null };
      });
      void writeRooms(Object.values(get().rooms));
      return;
    }
    // A background refresh failure is transient; only the first load replaces the view with an error.
    if (quiet) return;
    const kept = await readRoom(id);
    if (get().selectedRoom !== id) return;
    if (kept) noteRoomMembers(kept);
    if (kept) return set({ roomView: kept, roomStale: true, roomMissing: false, roomError: null, rooms: get().rooms[id] ? { ...get().rooms, [id]: summaryPatch(kept, get().rooms[id]) } : get().rooms });
    set({ roomMissing: true, roomError: error instanceof Error ? error.message : "Couldn't load the room" });
  }
}

/** A deleted room leaves nothing behind: its copy, and the copies of the conversations it held. */
async function forgetRoomCopy(id: string) {
  storeShared.deletedRooms.add(id);
  const room = get().roomView?.id === id ? get().roomView : await readRoom(id).catch(() => null);
  const members = new Set((room?.members ?? []).flatMap((member) => typeof member.threadId === "string" && member.threadId ? [member.threadId] : []));
  for (const [threadId, roomId] of storeShared.roomOfThread) if (roomId === id) members.add(threadId);
  forgetThreadCopy([...members]);
  // Member copies saved for this room (former members too) and the pictures it showed go with it.
  revokeAssetHandles(await forgetRoom(id));
}

/**
 * Paints the room this device kept while the gateway answers; the live fetch replaces it whole.
 * Finding nothing is an answer too, and it comes from storage: the page must not wait for a
 * network timeout to say the room is not here.
 */
async function hydrateRoom(id: string) {
  const kept = await readRoom(id);
  if (get().selectedRoom !== id || get().roomView || get().roomGone) return;
  if (!kept) return set({ roomMissing: true });
  noteRoomMembers(kept);
  set((s) => ({ roomView: kept, roomStale: true, roomMissing: false, roomError: null, rooms: s.rooms[id] ? { ...s.rooms, [id]: summaryPatch(kept, s.rooms[id]) } : s.rooms }));
}

/** Opens a room. Live updates arrive via /api/events SSE. */
export function selectRoom(id: string | null) {
  stopRoomPoll();
  if (!id) {
    set({ selectedRoom: null, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: get().page === "room" ? null : get().page });
    return;
  }
  set({ selectedRoom: id, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: "room", projectItemId: null, exchangeBotSlug: null });
  markRoomSeen(id);
  void hydrateRoom(id);
  void loadRoom(id);
}

/** RoomView calls this after history restore put the room page back without `selectRoom`. */
export function ensureRoom(id: string) {
  if (get().selectedRoom !== id) {
    if (get().roomView?.id === id) {
      set({ selectedRoom: id, page: "room", projectItemId: null, exchangeBotSlug: null });
      markRoomSeen(id);
      return;
    }
    selectRoom(id);
    return;
  }
  markRoomSeen(id);
  void loadRoom(id, true);
}

/** Creates the room. It does not open it: the caller decides with `showRoom` how the page moves. */
export async function createRoom(input: CreateRoomInput) {
  const room = await createRoomApi(input);
  await loadRooms().catch(() => {});
  return room;
}

/** Closes the open dialog and opens the room in one update. */
export function showRoom(id: string) {
  stopRoomPoll();
  set({ dialog: null, selectedRoom: id, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: "room", projectItemId: null, exchangeBotSlug: null });
  markRoomSeen(id);
  void hydrateRoom(id);
  void loadRoom(id);
}

export async function saveRoom(id: string, input: UpdateRoomInput) {
  const room = await updateRoomApi(id, input);
  const fallback: RoomSummary = {
    id: room.id, name: room.name, description: room.description, section: room.section, pinned: room.pinned,
    mode: room.settings.mode, members: [], lastTurnAt: null, lastActivityAt: null, lastText: "", queued: 0, running: false,
  };
  set((s) => ({
    rooms: { ...s.rooms, [room.id]: summaryPatch(room, s.rooms[room.id] ?? fallback) },
    roomView: s.selectedRoom === room.id ? room : s.roomView,
    ...(s.selectedRoom === room.id ? { roomStale: false } : {}),
  }));
  void writeRoom(room);
  return room;
}

export async function removeRoom(id: string) {
  const result = await deleteRoomApi(id);
  clearRoomDraft(id);
  void forgetRoomCopy(id);
  try {
    const roomSeen = { ...get().roomSeen };
    delete roomSeen[id];
    localStorage.setItem("threebot.rooms.seen", JSON.stringify(roomSeen));
    set({ roomSeen });
  } catch { /* private mode */ }
  const leaving = get().selectedRoom === id;
  stopRoomPoll();
  set((s) => {
    const rooms = { ...s.rooms };
    delete rooms[id];
    return { rooms, ...(leaving ? { selectedRoom: null, roomView: null, roomStale: false, roomMissing: false, roomGone: false, roomError: null, page: s.page === "room" ? null : s.page } : {}) };
  });
  // The saved sidebar list must not name a deleted room on the next launch.
  void writeRooms(Object.values(get().rooms));
  return result;
}

/** A room on screen from its saved copy may have changed: nothing is changed in it until it is live. */
function liveRoom(id: string) {
  if (get().selectedRoom === id && get().roomStale) throw new Error("This room is a saved copy. Try again once it has loaded.");
}

export async function resetRoom(id: string) {
  liveRoom(id);
  const room = await resetRoomApi(id);
  set((s) => ({ roomView: s.selectedRoom === id ? room : s.roomView, ...(s.selectedRoom === id ? { roomStale: false } : {}) }));
  void writeRoom(room);
  await loadRooms().catch(() => {});
  return room;
}

/** Sends from the room composer; the turn index is re-read so the user's bubble lands at once. */
export async function sendRoomMessage(id: string, text: string, mentions: string[], replyTo: string | null = null, attachments: Attachment[] = []): Promise<RoomTurn> {
  // The room keeps the metadata; T3 keeps the bytes, and every addressed member claims its own copy.
  const turn = await sendRoomMessageApi(id, { text, mentions, replyTo, attachments: attachments.map(({ previewUrl: _preview, environmentId: _environment, ...attachment }) => attachment) });
  await loadRoom(id, true);
  void loadRooms().catch(() => {});
  return turn;
}

export async function stopRoom(id: string) {
  liveRoom(id);
  await stopRoomApi(id);
  await loadRoom(id, true);
  void loadRooms().catch(() => {});
}

// Back/forward can leave the room page without going through `select` or `selectThread`.
useApp.subscribe((state, prev) => {
  if (prev.page === "room" && state.page !== "room" && state.selectedRoom) {
    stopRoomPoll();
    set({ selectedRoom: null, roomView: null, roomError: null });
  }
});
