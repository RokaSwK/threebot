import { memo } from "react";
import { queuedWork, useWorkCommand, type WorkState } from "../lib/runtimeApi";

export function WorkFeedback({ action }: { action: ReturnType<typeof useWorkCommand> }) {
  if (action.state === "idle") return null;
  return <p className="mt-2 text-[12px] text-muted" role={action.state === "error" ? "alert" : "status"}>
    {action.state === "error" ? <>Couldn't confirm this change. <button className="underline" onClick={action.retry}>Retry</button></> : action.state === "sending" ? "Sending…" : "Waiting for Bot to confirm…"}
  </p>;
}

export const QueuedWork = memo(function QueuedWork({ state }: { state: WorkState }) {
  const queue = queuedWork(state);
  if (!queue.length) return null;
  return <section aria-label="Queued work" className="my-2 w-full max-w-[560px] text-[13px] text-muted">
    <p>{queue.length} queued {queue.length === 1 ? "message" : "messages"}</p>
    {queue.map(({ run, message }) => <div key={run.id} data-queued-run={run.id} className="mt-2">
      <p className="line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{message?.text || (message?.attachments.length ? "Attachments" : "Message unavailable")}</p>
      {!!message?.attachments.length && <p>{message.attachments.map(a => a.name).join(", ")}</p>}
    </div>)}
  </section>;
});
