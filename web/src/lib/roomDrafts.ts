// A room draft belongs to the room, not to the mounted component: leaving the view or reloading
// the PWA must not throw away what the user was writing or the files they had chosen.
const key = (id: string) => `threebot.room.draft.${id}`;

type DraftAttachment = { type: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number };
export type RoomDraft = { text: string; attachments: DraftAttachment[]; uploading: DraftAttachment[] };

function readAttachment(value: unknown): DraftAttachment | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if ((item.type !== "image" && item.type !== "file") || typeof item.id !== "string" || !item.id) return null;
  if (typeof item.name !== "string" || !item.name.trim() || typeof item.mimeType !== "string") return null;
  if (typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return null;
  return { type: item.type, id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes };
}

function readAttachments(value: unknown): DraftAttachment[] {
  return Array.isArray(value) ? value.flatMap((item) => readAttachment(item) ?? []) : [];
}

export function readRoomDraft(id: string): RoomDraft {
  let raw = "";
  try { raw = localStorage.getItem(key(id)) ?? ""; } catch { return { text: "", attachments: [], uploading: [] }; }
  if (!raw) return { text: "", attachments: [], uploading: [] };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "text" in value && typeof value.text === "string" && "attachments" in value && Array.isArray(value.attachments)) {
      return {
        text: value.text,
        attachments: readAttachments(value.attachments),
        // A file that was still uploading when the view went away cannot be resumed: it is kept
        // here only so the composer can tell the user to attach it again.
        uploading: "uploading" in value ? readAttachments((value as { uploading?: unknown }).uploading) : [],
      };
    }
  } catch { /* An older draft was saved as plain text. */ }
  return { text: raw, attachments: [], uploading: [] };
}

export function writeRoomDraft(id: string, draft: RoomDraft): void {
  try {
    const uploading = draft.uploading ?? [];
    if (!draft.text && draft.attachments.length === 0 && uploading.length === 0) localStorage.removeItem(key(id));
    else localStorage.setItem(key(id), JSON.stringify({ text: draft.text, attachments: draft.attachments, ...(uploading.length ? { uploading } : {}) }));
  } catch { /* Private mode or a full quota: the draft is a convenience, not state. */ }
}

export function clearRoomDraft(id: string): void {
  writeRoomDraft(id, { text: "", attachments: [], uploading: [] });
}
