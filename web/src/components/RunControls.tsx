import { useEffect, useMemo, useState } from "react";
import { forceStopThread, selectThread, useApp, watchThread } from "../store";
import { ApprovalCard } from "./Cards";
import { Pill } from "./ui";
import { buildEntries, isActiveRun, type Entry } from "../lib/transcript";
import { requestStatus } from "../lib/runtimeRequests";
import { threadTarget } from "../lib/t3";
import type { Bot, ThreadShell, TurnItem } from "../lib/types";

/** Questions and sign-in refreshes stay in the child; everything else is an approval. */
export function asksForApproval(thread: ThreadShell) {
  const kind = thread.pendingRuntimeRequest?.kind;
  return !!kind && kind !== "user_input" && kind !== "auth_refresh";
}

/** Direct children (subagents and delegated threads) waiting on an approval. Side chats have their own sheet. */
export function childrenAwaitingApproval(threads: Record<string, ThreadShell>, parentThreadId: string) {
  return Object.values(threads)
    .filter((t) => t.lineage?.parentThreadId === parentThreadId && t.lineage.sideChat !== true && !t.archivedAt && asksForApproval(t))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A child's approval, answered from the parent conversation. */
export function ChildApprovals({ bot, threadId }: { bot: Bot; threadId: string }) {
  const threads = useApp((s) => s.threads);
  const children = useMemo(() => childrenAwaitingApproval(threads, threadId), [threads, threadId]);
  if (!children.length) return null;
  return <>{children.map((child) => <ChildApproval key={child.id} bot={bot} child={child} />)}</>;
}

function ChildApproval({ bot, child }: { bot: Bot; child: ThreadShell }) {
  useEffect(() => watchThread(child.id), [child.id]);
  const data = useApp((s) => s.threadData[child.id]);
  const approvals = useMemo(() => {
    const items = Object.values(data?.items ?? {}).filter((item: TurnItem) => item.type === "approval_request");
    const requests = data?.requests ?? {};
    return buildEntries(items, { bot, botsByThread: new Map(), tasks: [], requests }).filter(
      (entry): entry is Extract<Entry, { kind: "approval" }> => entry.kind === "approval" && requestStatus(entry.item, entry.request) === "pending",
    );
  }, [data?.items, data?.requests, bot]);
  if (!approvals.length) return null;
  const name = child.title || "Subagent";
  return <div aria-label={`Approval from ${name}`} className="my-1">
    <button onClick={() => selectThread(bot, child.id)} className="px-2.5 pt-1 text-left text-[12.5px] text-muted hover:underline">From {name}</button>
    {approvals.map((entry) => <ApprovalCard key={entry.id} entry={entry} threadId={child.id} />)}
  </div>;
}

/** The latest Stop the agent didn't confirm, while its run is still going. */
export function unresponsiveStop(items: TurnItem[], runs: Record<string, { status: string } | undefined>) {
  const stop = items
    .filter((item) => item.type === "run_interrupt_request" && typeof item.unresponsiveAt === "string" && item.runId)
    .sort((a, b) => b.ordinal - a.ordinal)[0];
  return stop && isActiveRun(runs[stop.runId!] as never) ? { runId: stop.runId! } : null;
}

export function ForceStop({ threadId, items, readOnly }: { threadId: string; items: TurnItem[]; readOnly: boolean }) {
  const supported = useApp((s) => s.runtimeFeatures.threadForceStop) && !threadTarget(threadId).environmentId;
  const runs = useApp((s) => s.threadData[threadId]?.runs);
  const stop = useMemo(() => unresponsiveStop(items, runs ?? {}), [items, runs]);
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => { setState("idle"); setError(""); }, [stop?.runId]);
  if (!stop || readOnly) return null;
  const send = async () => {
    if (state === "sending") return;
    setState("sending"); setError("");
    try { await forceStopThread(threadId, stop.runId); setState("idle"); }
    catch (cause) { setState("error"); setError(cause instanceof Error ? cause.message : "Couldn't force stop the agent"); }
  };
  return <div role="status" className="my-2 flex flex-wrap items-center gap-2 rounded-[14px] bg-card px-3.5 py-2.5 text-[13px]">
    <span className="min-w-0 flex-1">{supported ? "The agent isn’t responding to Stop." : "The agent isn’t responding to Stop. Force stop it from T3 Code."}</span>
    {supported && <Pill variant="soft" disabled={state === "sending"} onClick={() => void send()}>{state === "sending" ? "Stopping…" : "Force stop"}</Pill>}
    {error && <p role="alert" className="w-full break-words text-[12px] text-danger">{error}</p>}
  </div>;
}
