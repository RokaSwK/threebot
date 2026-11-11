import { memo, useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { MachineBadge } from "./MachineBadge";
import { threadKey } from "../lib/t3";
import clsx from "clsx";
import { ActivityAvatar } from "./ActivityAvatar";
import { isSideChat } from "../lib/sideChats";
import { botReferenceKey, conversationStatus, loadThreadFamily, selectThread, useApp } from "../store";
import { agentStatus, localAncestors, sameTaskBot, subagentStatus, subagentTarget, supplementSubagents, threadIdentity, threadLink, variantShape, type ThreadTarget } from "../lib/threadFamily";
import type { Bot, TurnItem } from "../lib/types";
import { useWorkCommand } from "../lib/runtimeApi";
import { WorkFeedback } from "./QueuedWork";

// Claude's placeholder when a subagent's report went to the parent as a message. Not a result.
const HANDBACK_NOTE = /^This agent's report was delivered to you as a message\b/;

export const SubagentRow = memo(function SubagentRow({ bot, parentThreadId, item }: { bot: Bot; parentThreadId: string; item: TurnItem }) {
  const update = useApp((s) => s.threadData[parentThreadId]?.subagents?.[item.subagentId]);
  const agent = update && update.updatedAt >= item.updatedAt ? { ...item, ...update } : item;
  const target = subagentTarget(agent);
  const childTitle = useApp(s => target?.kind === "local" ? s.threads[target.threadId]?.title : undefined);
  const status = useApp(s => agentStatus({ thread: target?.kind === "local" ? s.threads[target.threadId] : undefined, fallback: agent.status, updatedAt: agent.updatedAt }));
  const threads = useApp.getState().threads;
  const archived = useApp(s => s.bots[bot.slug]?.mainThreadId !== bot.mainThreadId);
  const action = useWorkCommand(`${agent.id}:${agent.status}:${agent.updatedAt}`);
  const parent = threadIdentity(bot, parentThreadId, threads);
  const identity = target?.kind === "local" && threads[target.threadId]
    ? threadIdentity(bot, target.threadId, threads)
    : { shape: variantShape(parent.shape, target ? target.kind === "remote" ? `${target.environmentId}:${target.threadId}` : target.threadId : item.subagentId || item.id), color: parent.color };
  const subagentId = typeof item.subagentId === "string" ? item.subagentId : update?.id;
  const stopTarget = typeof agent.runId === "string" && subagentId ? { runId: agent.runId, subagentId } : null;
  const cancellable = !archived && ["pending", "running", "waiting"].includes(status) && stopTarget !== null;
  const result = typeof agent.result === "string" && agent.result && !HANDBACK_NOTE.test(agent.result) ? agent.result : undefined;
  const description = typeof agent.progress === "string" && ["pending", "running", "waiting"].includes(status) ? agent.progress : result;
  return <div><ThreadRow bot={bot} target={target} shape={identity.shape} color={identity.color} title={agent.title || childTitle || "Subagent"} status={status} description={description} />
    {cancellable && stopTarget && <div className="px-3 pb-1.5 text-[12px] text-muted"><button disabled={action.disabled} onClick={() => void action.send({ type: "subagent.stop", threadId: parentThreadId, ...stopTarget })}>Stop task</button></div>}
    {!target && result && <details className="px-3 pb-1.5 text-[12px] text-muted"><summary>Task result</summary><p className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</p></details>}
    <div className="px-3 pb-1"><WorkFeedback action={action} /></div>
  </div>;
}, (previous, next) => previous.item === next.item && previous.parentThreadId === next.parentThreadId && sameTaskBot(previous.bot, next.bot));

function ThreadRow({ bot, target, shape, color, avatarImage, title, status, current = false, description }: {
  bot: Bot; target: ThreadTarget | null; shape: string; color: string; avatarImage?: string | null; title: string; status: string; current?: boolean; description?: string;
}) {
  const working = ["pending", "preparing", "starting", "running", "queued"].includes(status);
  const machine = useApp((s) => target?.kind === "remote" ? s.machines?.find((candidate) => candidate.environmentId === target.environmentId) : undefined);
  const content = <>
    <ActivityAvatar threadId={target?.kind === "local" ? target.threadId : null} status={status} shape={shape} color={color} picture={avatarImage} size={24} />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[14px] leading-5" title={title}>{title}</span>
      {description && <span className="block truncate text-[12px] leading-4 text-muted" title={description}>{description}</span>}
    </span>
    {target?.kind === "remote" && <MachineBadge environmentId={target.environmentId} fallback={target.label} />}
    <span className={clsx("inline-flex shrink-0 items-center gap-1.5 text-[12px]", status === "completed" ? "text-success" : status === "failed" ? "text-danger" : status === "waiting" ? "text-attention" : "text-muted")}><span aria-hidden="true" className={clsx("size-1.5 shrink-0 rounded-full bg-current", working && "animate-pulse")} />{subagentStatus(status)}</span>
    {target && <ChevronRight size={14} className="shrink-0 text-muted" />}
  </>;
  const className = clsx("flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-[12px] px-2.5 py-1.5 text-left", current ? "bg-active" : target ? "hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" : "");
  // Threads on machines the gateway reaches (Settings → Machines) open inside the app; others hand off to T3.
  const inApp = target?.kind === "local" || (!!machine && machine.route !== "none");
  const key = target ? target.kind === "remote" ? threadKey({ environmentId: target.environmentId, threadId: target.threadId }) : target.threadId : null;
  const href = target?.kind === "local" ? `?bot=${encodeURIComponent(botReferenceKey(bot))}&thread=${encodeURIComponent(target.threadId)}`
    : target && inApp ? `?bot=${encodeURIComponent(botReferenceKey(bot))}&environment=${encodeURIComponent(target.environmentId)}&thread=${encodeURIComponent(target.threadId)}` : target ? threadLink(target) : undefined;
  return target ? <a className={className} href={href} target={inApp ? undefined : "_blank"} rel={inApp ? undefined : "noreferrer"} aria-current={current ? "page" : undefined} onClick={(e) => {
    if (inApp && key && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); selectThread(bot, key); }
  }} title={target.kind === "remote" ? `Open ${title} on ${target.label}` : `Open ${title}`} data-thread-id={target.threadId} data-subagent-status={status} data-avatar-shape={shape} data-avatar-color={color}>{content}</a>
    : <div className={className} data-subagent-status={status} data-avatar-shape={shape} data-avatar-color={color}>{content}</div>;
}

export function ThreadFamily({ bot, threadId }: { bot: Bot; threadId: string }) {
  const threads = useApp((s) => s.threads);
  const data = useApp((s) => s.threadData);
  useEffect(() => { loadThreadFamily(threadId); }, [threadId]);
  const parents = localAncestors(threadId, threads);
  const parentIds = new Set(parents.map((t) => t.id));
  const current = threads[threadId];
  const descendants = Object.values(threads).filter((t) => t.lineage.parentThreadId === threadId && !isSideChat(t));
  const items = supplementSubagents(Object.values(data[threadId]?.items ?? {}), Object.values(data[threadId]?.subagents ?? {}), threadId).filter((i) => i.type === "subagent");
  const represented = new Set(items.flatMap((i) => { const t = subagentTarget(i); return t?.kind === "local" ? [t.threadId] : []; }));
  const rows = parents.map((t) => ({ thread: t, relation: "Parent" }));
  if (bot.mainThreadId && threadId !== bot.mainThreadId && !parentIds.has(bot.mainThreadId) && threads[bot.mainThreadId]) rows.unshift({ thread: threads[bot.mainThreadId], relation: "Bot" });
  if (current) rows.push({ thread: current, relation: "Current" });
  return <section aria-label="Thread lineage" className="mb-5">
    <h3 className="mb-2 px-1 text-[12.5px] text-muted">Lineage</h3>
    <div className="overflow-hidden rounded-2xl bg-card p-1">
      {rows.map(({ thread, relation }) => {
        const identity = threadIdentity(bot, thread.id, threads);
        return <div key={thread.id} className={relation !== "Current" ? "border-b border-line" : ""}>
          <ThreadRow bot={bot} target={{ kind: "local", threadId: thread.id }} {...identity} title={identity.name} status={conversationStatus(thread.id)} current={thread.id === threadId} />
        </div>;
      })}
      {(items.length > 0 || descendants.length > 0) && <div className="px-3 pt-3 pb-1 text-[12px] text-muted">Subagents</div>}
      {items.map((item) => <SubagentRow key={item.id} bot={bot} parentThreadId={threadId} item={item} />)}
      {descendants.filter((t) => !represented.has(t.id)).map((t) => {
        const identity = threadIdentity(bot, t.id, threads);
        return <ThreadRow key={t.id} bot={bot} target={{ kind: "local", threadId: t.id }} {...identity} title={identity.name} status={conversationStatus(t.id)} />;
      })}
    </div>
  </section>;
}
