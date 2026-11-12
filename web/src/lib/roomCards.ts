import { buildEntries, type Entry } from "./transcript";
import { requestStatus, secretStatus } from "./runtimeRequests";
import type { MemberView, RoomView } from "./rooms";
import type { Bot, RuntimeRequest, TurnItem } from "./types";

export type RoomCardEntry = Extract<Entry, { kind: "approval" } | { kind: "question" } | { kind: "secret" }>;
export type RoomCard = {
  kind: "card";
  id: string;
  at: string;
  member: MemberView;
  threadId: string;
  entry: RoomCardEntry;
};

type ThreadSlice = {
  items: Record<string, TurnItem>;
  requests?: Record<string, RuntimeRequest>;
};

/**
 * The pending requests a member is waiting on, ready to render inline in the room. A resolved card
 * is left out: the member's reply is the room line, and replaying old cards would clutter the room.
 * When `knownRuns` is given, a card from a run the room never recorded (a message sent directly in
 * the member's thread) is left out too.
 */
export function roomCards(
  room: Pick<RoomView, "members"> | null,
  threadData: Record<string, ThreadSlice>,
  bots: Record<string, Bot>,
  knownRuns?: Set<string>,
): RoomCard[] {
  if (!room) return [];
  const cards: RoomCard[] = [];
  for (const member of room.members) {
    const threadId = member.threadId;
    if (!threadId) continue;
    const data = threadData[threadId];
    const bot = bots[member.slug];
    if (!data || !bot) continue;
    const entries = buildEntries(Object.values(data.items), {
      bot,
      botsByThread: new Map<string, Bot>(),
      tasks: [],
      requests: data.requests ?? {},
    });
    for (const entry of entries) {
      if (entry.kind !== "approval" && entry.kind !== "question" && entry.kind !== "secret") continue;
      if (knownRuns) {
        const runId = entry.item.runId;
        if (!runId || !knownRuns.has(runId)) continue;
      }
      const pending = entry.kind === "secret"
        ? secretStatus(entry.item) === "pending"
        : requestStatus(entry.item, entry.request) === "pending";
      if (!pending) continue;
      cards.push({
        kind: "card",
        id: `card:${threadId}:${entry.id}`,
        at: entry.item.startedAt ?? entry.item.updatedAt,
        member,
        threadId,
        entry,
      });
    }
  }
  return cards;
}
