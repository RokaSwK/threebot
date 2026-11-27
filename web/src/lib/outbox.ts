// Persistent offline send outbox so messages queued offline flush automatically on reconnect.
import type { Attachment } from "../store/context";

export type OutboxEntry = {
  id: string;
  slug: string;
  threadId: string;
  text: string;
  attachments: Attachment[];
  fresh: boolean;
  queuedAt: number;
};

const OUTBOX_KEY = "threebot.outbox.v1";

function readOutbox(): OutboxEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((e): e is OutboxEntry => Boolean(e && typeof e.id === "string" && typeof e.threadId === "string")) : [];
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]) {
  try {
    if (entries.length === 0) localStorage.removeItem(OUTBOX_KEY);
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
  } catch { /* storage quota / private mode */ }
}

export function queueOutboxMessage(entry: OutboxEntry) {
  const list = readOutbox().filter((e) => e.id !== entry.id);
  list.push(entry);
  writeOutbox(list);
}

export function listOutbox(threadId?: string): OutboxEntry[] {
  const list = readOutbox();
  return threadId ? list.filter((e) => e.threadId === threadId) : list;
}

export async function flushOutbox(dispatch: (entry: OutboxEntry) => Promise<void>): Promise<number> {
  const list = readOutbox();
  if (!list.length) return 0;
  const remaining: OutboxEntry[] = [];
  let sent = 0;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    try {
      await dispatch(entry);
      sent++;
    } catch {
      remaining.push(...list.slice(i));
      break;
    }
  }
  writeOutbox(remaining);
  return sent;
}
