import { memo } from "react";
import { GitPullRequest } from "lucide-react";
import type { WorkState } from "../lib/runtimeApi";

export const TaskChanges = memo(function TaskChanges({ state }: { state: WorkState }) {
  if (!state.pullRequests.length) return null;
  return <div className="my-2 flex flex-wrap gap-2">
    {state.pullRequests.map(pr => <a key={`${pr.host}:${pr.repository}:${pr.number}`} href={pr.url} target="_blank" rel="noreferrer" title="PR status may be stale" className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px] text-muted">
      <GitPullRequest size={15} />Open PR #{pr.number}
    </a>)}
  </div>;
});
