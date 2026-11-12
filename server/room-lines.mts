// The pure part of a room turn: who is addressed, how a line reads, when a reply is a pass, and
// which turn item is the reply. Shared with the web the same way mention-rules.mts is, so the
// composer, the view and the engine agree on what `@Name` means.
import { mentionsInText } from "./mention-rules.mts";

export type RoomAuthor = { kind: "user" } | { kind: "bot"; slug: string; name: string };

export type RoomLine = {
  at: string;
  author: RoomAuthor;
  text: string;
  /** Set when this line answers another one: `Name` of the author being answered. */
  replyToName?: string | null;
};

export type RoomMemberName = { slug: string; name: string };

/** `@all` / `@everyone` address every member; the same code fences and boundaries apply. */
const EVERYONE = "everyone";

/**
 * The members a user message addresses.
 * `mentions` wins when the composer resolved it; otherwise the text is parsed with the shared rules.
 */
export function addressedMembers(text: string, members: RoomMemberName[], policy: "anywhere" | "leading"): { slugs: string[]; all: boolean } {
  const names = members.map((member) => member.name).concat([EVERYONE]);
  const matched = mentionsInText(text, names, policy);
  const all = matched.some((name) => name.toLowerCase() === "all" || name.toLowerCase() === EVERYONE);
  if (all) return { slugs: members.map((member) => member.slug), all: true };
  const byName = new Map(members.map((member) => [member.name.toLowerCase(), member.slug]));
  const slugs = matched.flatMap((name) => {
    const slug = byName.get(name.toLowerCase());
    return slug ? [slug] : [];
  });
  return { slugs: [...new Set(slugs)], all: false };
}

/** A member with nothing to add answers exactly `(pass)`; the room line and the push skip it. */
export function isPass(text: string): boolean {
  return /^\(?\s*pass\s*\)?$/i.test(text.trim());
}

/** One line of the transcript as the room and the prompt show it. */
export function formatRoomLine(line: RoomLine): string {
  const who = line.author.kind === "user" ? "User" : line.author.name;
  const quote = line.replyToName ? `[replying to ${line.replyToName}: "${clip(line.text, 80)}"] ` : "";
  return `${who}: ${quote}${line.text.trim()}`;
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

export type ReplyItem = {
  id?: string;
  runId?: string | null;
  ordinal?: number;
  type?: string;
  status?: string;
  text?: unknown;
  completedAt?: string | null;
  updatedAt?: string | null;
};

/**
 * The reply of a run: the last completed assistant message that belongs to it.
 * Tool rows, questions and reasoning are not replies.
 */
export function pickReply(items: ReplyItem[], runId: string | null | undefined): { id: string; text: string; at: string | null } | null {
  if (!runId) return null;
  const assistant = items.filter((item) =>
    item.runId === runId
    && (item.type === "assistant_message" || item.type === "assistant")
    && item.status === "completed"
    && typeof item.text === "string"
    && item.text.trim() !== ""
  );
  const last = assistant.at(-1);
  if (!last) return null;
  return { id: String(last.id ?? ""), text: String(last.text), at: last.completedAt ?? last.updatedAt ?? null };
}
