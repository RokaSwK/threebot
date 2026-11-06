// What T3 doesn't keep for a conversation: the roster preview, which its wire
// projection always nulls, plus reactions and the voice call log.
import { promises as fs } from "node:fs";
import path from "node:path";

const THREAD_ID = /^[\w:%.-]{1,300}$/;
const ITEM_ID = /^[\w:%.-]{1,600}$/;
const EMOJI = /^(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}])[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Component}‍️]{1,16}$/u;
const MAX_STAMPS = 200;

/** One turn item of T3's thread projection, as far as the preview reads it. */
export type TurnItem = {
  ordinal: number;
  type?: string;
  status?: string;
  toolName?: string;
  completedAt?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  text?: unknown;
  attachments?: unknown[] | null;
  questions?: unknown;
  input?: unknown;
};
/** T3's `orchestration.getThreadProjection` result; rows are either the item or `{ item }`. */
export type ThreadProjection = { visibleTurnItems?: ProjectionRow[] | null; turnItems?: ProjectionRow[] | null };
type ProjectionRow = (Partial<TurnItem> & { item?: TurnItem | null }) | null | undefined;
export type Preview = { kind: "text" | "attachment" | "question" | "sent"; role: "user" | "assistant"; text: string; at: string | null };
export type NameFor = (threadId: string) => string | null | undefined;
type VoiceCall = { at: string; seconds: number };
type ThreadState = { reactions: Record<string, string[]>; voiceCalls: VoiceCall[] };

const toolName = (item: TurnItem) => String(item.toolName ?? "").split(/__|\./).at(-1);
// Tool inputs and questions are T3's JSON, read loosely.
function parsed(value: unknown): any {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}

/** One line of Markdown as it reads, without its syntax or T3's hidden context. */
export function previewText(value: unknown): string {
  return String(value ?? "")
    .replace(/^Ultrathink:\s*/i, "")
    .replace(/^<reply-context>[\s\S]*?<\/reply-context>\s*/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s*<t3-thread:[^>]*>/g, "")
    .replace(/^From [^:\n]{1,80}:\s*/, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** The newest thing a person would recognize in this conversation, or null when it has none. */
export function latestPreview(projection: ThreadProjection | null | undefined, nameFor: NameFor = () => null): Preview | null {
  const rows = projection?.visibleTurnItems ?? projection?.turnItems ?? [];
  const items = (rows.map((row) => row?.item ?? row).filter(Boolean) as TurnItem[]).sort((a, b) => b.ordinal - a.ordinal);
  for (const item of items) {
    const at = item.completedAt ?? item.startedAt ?? item.updatedAt ?? null;
    if (item.type === "user_message" || item.type === "assistant_message") {
      const role = item.type === "user_message" ? "user" : "assistant";
      const text = previewText(item.text);
      if (text) return { kind: "text", role, text, at };
      if (item.attachments?.length) return { kind: "attachment", role, text: "Attachment", at };
    } else if (item.type === "user_input_request") {
      const text = previewText(parsed(item.questions)?.[0]?.question);
      if (text) return { kind: "question", role: "assistant", text, at };
    } else if (item.type === "dynamic_tool" && item.status === "completed" && toolName(item) === "t3_thread_send") {
      const input = parsed(item.input);
      const text = previewText(input.message);
      if (text) return { kind: "sent", role: "assistant", text: `Messaged ${nameFor(input.threadId) ?? "a Bot"}: ${text}`, at };
    }
  }
  return null;
}

/** Previews are recomputed only for threads whose `updatedAt` stamp moved. */
export function createThreadPreviews({ projection, nameFor, concurrency = 4 }: { projection: (threadId: string) => Promise<ThreadProjection | null | undefined>; nameFor: () => Promise<NameFor>; concurrency?: number }): (stamps: unknown) => Promise<Record<string, Preview>> {
  const cache = new Map<string, { stamp: string; preview: Preview | null }>();
  const load = async (threadId: string, stamp: string) => {
    const preview = latestPreview(await projection(threadId), await nameFor());
    cache.set(threadId, { stamp, preview });
  };
  return async (stamps: unknown) => {
    if (!stamps || typeof stamps !== "object" || Array.isArray(stamps)) throw Object.assign(new Error("stamps must be an object"), { status: 400 });
    const entries = Object.entries(stamps);
    if (entries.length > MAX_STAMPS || entries.some(([id, stamp]) => !THREAD_ID.test(id) || typeof stamp !== "string")) throw Object.assign(new Error("invalid stamps"), { status: 400 });
    const stale = entries.filter(([id, stamp]) => cache.get(id)?.stamp !== stamp);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, stale.length) }, async () => {
      while (next < stale.length) {
        const [id, stamp] = stale[next++];
        // A failed thread keeps its earlier preview and is retried with the next request.
        await load(id, stamp).catch(() => {});
      }
    }));
    return Object.fromEntries(entries.flatMap(([id, stamp]) => cache.get(id)?.stamp === stamp && cache.get(id)?.preview ? [[id, cache.get(id)!.preview!]] : []));
  };
}

function checked(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw Object.assign(new Error(`invalid ${label}`), { status: 400 });
  return value;
}

export function createThreadMeta({ file, now = () => new Date().toISOString() }: { file: string; now?: () => string }) {
  let state: Record<string, ThreadState> | null = null;
  let writes = Promise.resolve();
  const read = async () => {
    if (state) return state;
    try { state = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = {}; }
    return state;
  };
  const save = () => {
    const text = JSON.stringify(state, null, 2) + "\n";
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + ".tmp", text);
      await fs.rename(file + ".tmp", file);
    });
    return writes;
  };
  // Only called after read(), so `state` is loaded.
  const view = (threadId: string) => ({ reactions: state![threadId]?.reactions ?? {}, voiceCalls: (state![threadId]?.voiceCalls ?? []).filter((call) => Number.isFinite(call.seconds) && call.seconds >= 10) });
  const thread = (threadId: string) => (state![threadId] ??= { reactions: {}, voiceCalls: [] });
  return {
    async get(threadId: string) {
      await read();
      return view(checked(threadId, THREAD_ID, "thread"));
    },
    async toggleReaction({ threadId, itemId, emoji }: { threadId: string; itemId: string; emoji: string }) {
      checked(threadId, THREAD_ID, "thread"); checked(itemId, ITEM_ID, "message"); checked(emoji, EMOJI, "reaction");
      await read();
      const { reactions } = thread(threadId);
      const current = reactions[itemId] ?? [];
      const next = current.includes(emoji) ? current.filter((value) => value !== emoji) : [...current, emoji];
      if (next.length) reactions[itemId] = next; else delete reactions[itemId];
      await save();
      return view(threadId);
    },
    async addVoiceCall({ threadId, seconds }: { threadId: string; seconds: number }) {
      checked(threadId, THREAD_ID, "thread");
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) throw Object.assign(new Error("invalid duration"), { status: 400 });
      await read();
      thread(threadId).voiceCalls.push({ at: now(), seconds: Math.round(seconds) });
      await save();
      return view(threadId);
    },
  };
}
