import { memo, useEffect } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import clsx from "clsx";
import { Avatar } from "./Avatar";
import { botReferenceKey, conversationStatus, loadThreadFamily, selectThread, useApp } from "../store";
import { agentStatus, localAncestors, sameTaskBot, subagentStatus, subagentTarget, supplementSubagents, threadIdentity, threadLink, variantShape, type ThreadTarget } from "../lib/threadFamily";
import type { Bot, TurnItem } from "../lib/types";
import { record, useWorkCommand } from "../lib/runtimeApi";
import { WorkFeedback } from "./QueuedWork";

// Claude's placeholder when a subagent's report went to the parent as a message. Not a result.
const HANDBACK_NOTE = /^This agent's report was delivered to you as a message\b/;

export const SubagentRow = memo(function SubagentRow({ bot, parentThreadId, item, card = false }: { bot: Bot; parentThreadId: string; item: TurnItem; card?: boolean }) {
  const update = useApp((s) => s.threadData[parentThreadId]?.subagents?.[item.subagentId]);
  const agent = update && update.updatedAt >= item.updatedAt ? { ...item, ...update } : item;
  const modelName = useApp((s) => s.providers.flatMap((provider) => provider.models).find((model) => model.slug === agent.model)?.name);
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
  const delivery = record(agent.completionDelivery);
  const subagentId = typeof item.subagentId === "string" ? item.subagentId : update?.id;
  const stopTarget = typeof agent.runId === "string" && subagentId ? { runId: agent.runId, subagentId } : null;
  const cancellable = !archived && ["pending", "running", "waiting"].includes(status) && stopTarget !== null;
  const result = typeof agent.result === "string" && agent.result && !HANDBACK_NOTE.test(agent.result) ? agent.result : undefined;
  const description = typeof agent.progress === "string" && ["pending", "running", "waiting"].includes(status) ? agent.progress : result;
  return <div><ThreadRow bot={bot} target={target} shape={identity.shape} color={identity.color} title={agent.title || childTitle || "Subagent"} status={status} card={card} description={description} />
    {(cancellable || agent.model || delivery.state) && <div className="flex flex-wrap items-center gap-3 px-3 pb-2 text-[12px] text-muted">
      {typeof agent.model === "string" && <span>{modelName ?? agent.model}</span>}
      {typeof delivery.state === "string" && <span>Result {delivery.state}</span>}
      {cancellable && stopTarget && <button disabled={action.disabled} onClick={() => void action.send({ type: "subagent.stop", threadId: parentThreadId, ...stopTarget })}>Stop task</button>}
    </div>}
    {card && result && <details className="px-3 pb-2 text-[12px] text-muted"><summary>Task result</summary><p className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{result}</p></details>}
    <div className="px-3 pb-1"><WorkFeedback action={action} /></div>
  </div>;
}, (previous, next) => previous.item === next.item && previous.parentThreadId === next.parentThreadId && previous.card === next.card && sameTaskBot(previous.bot, next.bot));

function ThreadRow({ bot, target, shape, color, avatarImage, title, status, current = false, card = false, description }: {
  bot: Bot; target: ThreadTarget | null; shape: string; color: string; avatarImage?: string | null; title: string; status: string; current?: boolean; card?: boolean; description?: string;
}) {
  const working = ["pending", "preparing", "starting", "running", "queued"].includes(status);
  const content = <>
    <Avatar shape={shape} color={color} picture={avatarImage} size={34} state={status === "failed" ? "failed" : working ? "working" : status === "waiting" ? "waiting" : "idle"} />
    <span className="min-w-0 flex-1">
      <span className={clsx("text-[14px] leading-5 font-medium [overflow-wrap:anywhere]", card ? "line-clamp-2" : "block truncate")} title={title}>{title}</span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
        <span className={clsx("inline-flex items-center gap-1.5", status === "completed" ? "text-success" : status === "failed" ? "text-danger" : status === "waiting" ? "text-attention" : "")}><span aria-hidden="true" className={clsx("size-1.5 shrink-0 rounded-full bg-current", working && "animate-pulse")} />{subagentStatus(status)}</span>
        {target?.kind === "remote" && <span className="min-w-0 truncate" title={target.label}>{target.label}</span>}
        {current && <span>This conversation</span>}
      </span>
      {description && <span className="mt-1 line-clamp-2 text-[12px] text-muted [overflow-wrap:anywhere]">{description}</span>}
      {card && target && <span className="mt-2 block text-[12px] text-muted">Open chat</span>}
    </span>
    {target && (target.kind === "remote" ? <ArrowUpRight size={15} className="shrink-0 text-muted" /> : <ChevronRight size={15} className="shrink-0 text-muted" />)}
  </>;
  const className = clsx("flex min-h-14 w-full min-w-0 items-center gap-3 rounded-[14px] px-3 py-3 text-left", current ? "bg-active" : target ? "hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" : "");
  return target ? <a className={className} href={target.kind === "local" ? `?bot=${encodeURIComponent(botReferenceKey(bot))}&thread=${encodeURIComponent(target.threadId)}` : threadLink(target)} target={target.kind === "remote" ? "_blank" : undefined} rel={target.kind === "remote" ? "noreferrer" : undefined} aria-current={current ? "page" : undefined} onClick={(e) => {
    if (target.kind === "local" && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); selectThread(bot, target.threadId); }
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
  const descendants = Object.values(threads).filter((t) => t.lineage.parentThreadId === threadId);
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
