import { memo } from "react";
import { Clock, Send } from "lucide-react";
import { queuedSender, queuedWork, useWorkCommand, type WorkState } from "../lib/runtimeApi";
import { useApp } from "../store";
import { useBotsByThread } from "./Cards";

export function WorkFeedback({ action }: { action: ReturnType<typeof useWorkCommand> }) {
  if (action.state === "idle") return null;
  return <p className="mt-2 text-[12px] text-muted" role={action.state === "error" ? "alert" : "status"}>
    {action.state === "error" ? <>Couldn't confirm this change. <button className="underline" onClick={action.retry}>Retry</button></> : action.state === "sending" ? "Sending…" : "Waiting for Bot to confirm…"}
  </p>;
}

export const QueuedWork = memo(function QueuedWork({ state }: { state: WorkState }) {
  const queue = queuedWork(state);
  const tasks = useApp((s) => s.tasks);
  const botsByThread = useBotsByThread();
  if (!queue.length) return null;
  const names = { routine: (id: string) => tasks.find((task) => task.id === id)?.title, thread: (id: string) => botsByThread.get(id)?.name };
  return <section aria-label="Queued work" className="my-2 w-full max-w-[560px] text-[13px] text-muted">
    <p>{queue.length} queued {queue.length === 1 ? "message" : "messages"}</p>
    {queue.map(({ run, message }) => {
      const sender = queuedSender(message, names);
      return <div key={run.id} data-queued-run={run.id} className="mt-2">
        {sender ? <details>
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5">
            {sender.kind === "routine" ? <Clock size={13} aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
            <span className="truncate">{sender.kind === "routine" ? "Routine" : "From"} · {sender.label}</span>
          </summary>
          <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{sender.text}</p>
        </details> : <p className="line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{message?.text || (message?.attachments.length ? "Attachments" : "Message unavailable")}</p>}
        {!!message?.attachments.length && <p>{message.attachments.map(a => a.name).join(", ")}</p>}
      </div>;
    })}
  </section>;
});
