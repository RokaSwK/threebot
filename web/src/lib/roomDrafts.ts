// A room draft belongs to the room, not to the mounted component: leaving the view or reloading
// the PWA must not throw away what the user was writing.
const key = (id: string) => `threebot.room.draft.${id}`;

export function readRoomDraft(id: string): string {
  try { return localStorage.getItem(key(id)) ?? ""; }
  catch { return ""; }
}

export function writeRoomDraft(id: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(id), text);
    else localStorage.removeItem(key(id));
  } catch { /* Private mode or a full quota: the draft is a convenience, not state. */ }
}

export function clearRoomDraft(id: string): void {
  writeRoomDraft(id, "");
}
