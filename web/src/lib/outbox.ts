// Persistent offline send outbox so messages queued offline flush automatically on reconnect.
import type { Attachment } from "../store/context";

export type OutboxEntry = {
  id: string;
  threadId: string;
  text: string;
  attachments: Attachment[];
  fresh: boolean;
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
  if (entries.length === 0) localStorage.removeItem(OUTBOX_KEY);
  else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
}

export function queueOutboxMessage(entry: OutboxEntry) {
  const list = readOutbox().filter((queued) => queued.id !== entry.id);
  list.push(entry);
  try { writeOutbox(list); }
  catch { throw new Error("This device couldn’t save the message for offline delivery."); }
}

export function clearOutbox() {
  try { writeOutbox([]); } catch { /* Storage may be unavailable. */ }
}

let flushing: Promise<number> | undefined;
export function flushOutbox(dispatch: (entry: OutboxEntry) => Promise<void>): Promise<number> {
  return flushing ??= drainOutbox(dispatch).finally(() => { flushing = undefined; });
}

async function drainOutbox(dispatch: (entry: OutboxEntry) => Promise<void>): Promise<number> {
  let sent = 0;
  let entry = readOutbox()[0];
  while (entry) {
    const id = entry.id;
    try {
      await dispatch(entry);
      // Re-read after the await so a new message queued during dispatch is preserved.
      const remaining = readOutbox().filter((queued) => queued.id !== id);
      writeOutbox(remaining);
      sent++;
      entry = remaining[0];
    } catch { break; }
  }
  return sent;
}
