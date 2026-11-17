// A room member can end its run before the work does: T3 records the children it delegated as
// `subagent` rows and wakes the thread again when each one finishes. These selectors read each
// member's line through that chain — the same rule the engine uses — so a progress note is never
// published as the answer, a report that arrives late still shows up, and the room can say what a
// Bot delegated and where it ran.
import { chainReply, chainRootOf, isPass, pickChainReply, pickReply, type ChainState, type DelegatedChild } from "../../../server/room-lines.mts";
import type { MemberView, RoomTurn } from "./rooms";
import type { Run, Subagent, TurnItem } from "./types";

type ThreadSlice = {
  items: Record<string, TurnItem>;
  runs: Record<string, Run>;
  subagents?: Record<string, Subagent>;
};

/** One room line: a member's answer for one run, read through its delegated chain. */
export type RoomLine = {
  id: string;
  at: string;
  member: MemberView;
  text: string;
  runId: string;
  pass: boolean;
  late: boolean;
};

/** A delegated task as the room shows it: what it is, how it went, and where it runs. */
export type DelegatedTask = DelegatedChild & { driver: string | null; model: string | null };
export type DelegatedRow = {
  id: string;
  at: string;
  member: MemberView;
  threadId: string;
  turnId: string;
  runId: string;
  chain: ChainState;
  tasks: DelegatedTask[];
  late: boolean;
};

const tasksOf = (data: ThreadSlice, chain: ChainState): DelegatedTask[] => chain.children.map((child) => {
  const agent = child.subagentId ? data.subagents?.[child.subagentId] : undefined;
  return {
    ...child,
    title: agent?.title ?? child.title,
    status: agent?.status ?? child.status,
    // The harness and the model the task runs on, straight from T3's subagent record.
    driver: (agent as { driver?: string | null } | undefined)?.driver ?? null,
    model: (agent as { model?: string | null } | undefined)?.model ?? null,
  };
});

/** The status the engine writes when a member's part of the turn is closed. */
const PART_OVER = new Set(["replied", "passed", "no-reply", "timeout", "stopped", "failed"]);

/**
 * The room's lines, one per member per run the room recorded. A member whose delegated work is
 * still out has no line yet: its last message is a progress note, not the answer.
 */
export function roomLines(members: MemberView[], turns: RoomTurn[], threadData: Record<string, ThreadSlice>): RoomLine[] {
  const out: RoomLine[] = [];
  for (const turn of turns) {
    for (const run of turn.runs ?? []) {
      if (!run.runId) continue;
      // The engine writes a status when the member's part closes. Until then the last message is a
      // progress note, so the room shows the delegation card and no line. Once it is closed the
      // line comes from the chain, without asking the browser to have seen every wake-up run.
      if (!run.status || !PART_OVER.has(run.status)) continue;
      const member = members.find((candidate) => candidate.slug === run.slug);
      const data = member?.threadId ? threadData[member.threadId] : null;
      if (!member || !data) continue;
      const items = Object.values(data.items);
      const runs = Object.values(data.runs ?? {});
      const root = chainRootOf(items, run.runId);
      const { chain, reply } = chainReply(items, runs, root);
      const line = reply ?? (chain.children.length > 0 ? pickChainReply(items, chain.runIds) : pickReply(items, run.runId));
      if (!line) continue;
      const text = line.text.trim();
      if (text === "") continue;
      out.push({
        id: `${run.runId}:${line.id}`,
        at: line.at ?? run.at ?? turn.at,
        member,
        text,
        runId: run.runId,
        pass: isPass(text),
        late: run.late === true,
      });
    }
  }
  return out;
}

/**
 * The delegated tasks behind a member's run, as a card after its line. Shown while the work is out
 * and after it lands, so the room keeps a record of what was delegated and where it ran.
 */
export function delegatedRows(members: MemberView[], turns: RoomTurn[], threadData: Record<string, ThreadSlice>): DelegatedRow[] {
  const rows: DelegatedRow[] = [];
  for (const turn of turns) {
    for (const run of turn.runs ?? []) {
      if (!run.runId) continue;
      const member = members.find((candidate) => candidate.slug === run.slug);
      const data = member?.threadId ? threadData[member.threadId] : null;
      if (!member || !data) continue;
      const items = Object.values(data.items);
      const runs = Object.values(data.runs ?? {});
      // The room registers the run that produced the line, which for a Bot that delegated in the
      // background is the wake-up run; the tasks belong to the run that started the chain.
      const root = chainRootOf(items, run.runId);
      const { chain, reply } = chainReply(items, runs, root);
      if (chain.children.length === 0) continue;
      const tasks = tasksOf(data, chain);
      const lastDone = tasks.reduce((newest, task) => Math.max(newest, Date.parse(task.completedAt ?? "") || 0), 0);
      const lineAt = reply?.at ?? pickChainReply(items, chain.runIds)?.at ?? null;
      rows.push({
        id: `delegated:${run.runId}`,
        at: lineAt ?? new Date(lastDone || Date.parse(turn.at) || 0).toISOString(),
        member,
        threadId: member.threadId!,
        turnId: turn.id,
        runId: run.runId,
        chain,
        tasks,
        late: run.late === true,
      });
    }
  }
  return rows;
}
