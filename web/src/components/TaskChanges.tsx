import { memo, useEffect, useRef, useState } from "react";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import clsx from "clsx";
import { prDone, prStatus, readPR, type PRTone, type WorkPR, type WorkState } from "../lib/runtimeApi";

/** A merged or closed chip stays this long at most before it leaves. */
export const PR_DONE_LINGER_MS = 60 * 60 * 1000;
const FOCUS_REFRESH_MS = 30_000;

const ICONS: Record<PRTone, typeof GitPullRequest> = { merged: GitMerge, open: GitPullRequest, draft: GitPullRequestDraft, closed: GitPullRequestClosed, unknown: GitPullRequest };
const TONES: Record<PRTone, string> = { merged: "text-merged", open: "text-success", draft: "text-muted", closed: "text-faint", unknown: "text-muted" };
const CHECKS: Record<string, string> = { passing: "bg-success", failing: "bg-danger", pending: "bg-faint motion-safe:animate-pulse" };

type Seen = { loaded: boolean; doneAt: number; doneAtMessages: number };

export const TaskChanges = memo(function TaskChanges({ state }: { state: WorkState }) {
  if (!state.pullRequests.length) return null;
  return <div className="my-2 flex flex-wrap gap-2 empty:hidden">
    {state.pullRequests.map(pr => <PRChip key={`${pr.host}:${pr.repository}:${pr.number}`} pr={pr} projectId={state.projectId} messages={state.messages.length} />)}
  </div>;
});

/** Display only: a PR finished before this thread loaded shows nothing; one that finishes while
 * open flips to Merged/Closed and leaves at the next user message or after an hour. */
function PRChip({ pr, projectId, messages }: { pr: WorkPR; projectId: string; messages: number }) {
  const [fetched, setFetched] = useState<{ base: WorkPR; value: WorkPR } | null>(null);
  const [checked, setChecked] = useState(!projectId);
  const [, expire] = useState(0);
  const seen = useRef<Seen | null>(null);
  const last = useRef(0);
  const current = useRef(pr);
  current.current = pr;
  // The stream wins once it reports something different from what the fetch was based on.
  const live = fetched && same(fetched.base, pr) ? fetched.value : pr;
  const done = prDone(live);
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const read = () => {
      const base = current.current;
      last.current = Date.now();
      readPR(projectId, base).then(value => alive && setFetched({ base, value }), () => {}).finally(() => alive && setChecked(true));
    };
    // Every mount reads, even from a finished snapshot (it may be stale); focus refreshes are throttled.
    const refresh = () => { if (!doneRef.current && Date.now() - last.current >= FOCUS_REFRESH_MS) read(); };
    read();
    window.addEventListener("focus", refresh);
    return () => { alive = false; window.removeEventListener("focus", refresh); };
  }, [projectId, pr.host, pr.repository, pr.number]);

  if (checked && !seen.current) seen.current = { loaded: done, doneAt: 0, doneAtMessages: 0 };
  const s = seen.current;
  if (s && done && !s.loaded && !s.doneAt) { s.doneAt = Date.now(); s.doneAtMessages = messages; }
  if (s && !done) s.doneAt = 0;
  const left = s?.doneAt ? s.doneAt + PR_DONE_LINGER_MS - Date.now() : 0;
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => expire(n => n + 1), left);
    return () => clearTimeout(timer);
  }, [left > 0, s?.doneAt]);

  if (!s || (done && (s.loaded || messages > s.doneAtMessages || left <= 0))) return null;
  const status = prStatus(live), Icon = ICONS[status.tone];
  return <a href={live.url} target="_blank" rel="noreferrer" title={live.title || `PR #${live.number}`} data-pr-state={status.tone} className={clsx("inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px]", done ? "text-faint" : "text-muted hover:bg-hover")}>
    <Icon size={15} className={TONES[status.tone]} aria-hidden />
    <span>{status.label}</span>
    {status.checks && <span className={clsx("size-1.5 rounded-full", CHECKS[status.checks])} aria-hidden />}
  </a>;
}

const same = (a: WorkPR, b: WorkPR) => a.state === b.state && a.draft === b.draft && a.checks === b.checks;
