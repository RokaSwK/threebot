import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { FileText, Grid2x2Plus, Clock, MessageSquareText, Search, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { Modal } from "./ui";
import { botReferenceKey, navigateSearchHit, openDialog, selectThread, toast, useApp, type SearchFilter } from "../store";
import { t3 } from "../lib/t3";
import { executorApi, type ExecutorApp } from "../lib/executor";
import { WorkspaceResourceViewer } from "./WorkspaceResource";
import type { Bot } from "../lib/types";

type Filter = SearchFilter;
const FILTERS: Filter[] = ["All", "Messages", "Bots", "Routines", "Files", "Apps"];
const MIN_MESSAGE_QUERY = 2;

type MessageMatch = { threadId: string; projectId: string; snippet: string; messageId?: string };
type Result =
  | { kind: "bot"; key: string; bot: Bot; detail: string }
  | { kind: "message"; key: string; bot: Bot; detail: string; threadId: string; messageId?: string }
  | { kind: "file"; key: string; bot: Bot; title: string; detail: string; path: string }
  | { kind: "app"; key: string; title: string; detail: string }
  | { kind: "routine"; key: string; bot: Bot; title: string; detail: string };

export function SearchDialog() {
  const bots = useApp((s) => s.bots);
  const historicalBots = useApp((s) => s.historicalBots);
  const previews = useApp((s) => s.previews);
  const tasks = useApp((s) => s.tasks);
  const [session] = useState(() => useApp.getState().searchSession);
  const [q, setQ] = useState(session.query);
  const [i, setI] = useState(session.index);
  const [filter, setFilter] = useState<Filter>(session.filter);
  const [files, setFiles] = useState<Extract<Result, { kind: "file" }>[]>([]);
  const [apps, setApps] = useState<ExecutorApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [resource, setResource] = useState<Extract<Result, { kind: "file" }> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [matches, setMatches] = useState<MessageMatch[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const needle = q.trim().toLowerCase();
  const workspaceKey = JSON.stringify(Object.values(bots).map((bot) => [bot.slug, bot.workspaceRoot]));

  useEffect(() => {
    setMatches([]); setFiles([]); setErrors([]); setLoading(false);
    if (needle.length < MIN_MESSAGE_QUERY) return;
    let current = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      const failures: string[] = [];
      const jobs: Promise<void>[] = [];
      if (filter === "All" || filter === "Messages") jobs.push(t3.call<{ matches: MessageMatch[] }>("orchestration.searchThreads", { query: needle.slice(0, 200), limit: 50 }).then((r) => { if (current) setMatches(r.matches); }).catch((error: Error) => { failures.push(`Messages: ${error.message}`); }));
      if (filter === "All" || filter === "Files") jobs.push((async () => {
        const found: Extract<Result, { kind: "file" }>[] = [];
        const workspaces = Object.values(bots); let next = 0;
        // Bound concurrent searches; do not send one unbounded RPC burst per Bot.
        await Promise.all(Array.from({ length: Math.min(3, workspaces.length) }, async () => {
          while (current && next < workspaces.length) {
            const bot = workspaces[next++];
            try {
              const result = await t3.call<{ entries: { path: string; kind: string }[]; truncated: boolean }>("projects.searchEntries", { cwd: bot.workspaceRoot, query: needle.slice(0, 200), limit: 20, kind: "file" });
              for (const entry of result.entries) found.push({ kind: "file", key: `file:${bot.slug}:${entry.path}`, bot, title: entry.path.split("/").at(-1) ?? entry.path, detail: `${bot.name} · ${entry.path}`, path: entry.path });
              if (result.truncated) failures.push(`${bot.name}: more file results are available; narrow your search.`);
            } catch (error) { failures.push(`${bot.name} files: ${error instanceof Error ? error.message : "Search unavailable"}`); }
          }
        }));
        if (current) setFiles(found);
      })());
      if (filter === "All" || filter === "Apps") jobs.push(executorApi.status().then((r) => { if (current) setApps(r.connections); if (r.error) failures.push(`Apps: ${r.error}`); }).catch((error: Error) => { failures.push(`Apps: ${error.message}`); }));
      await Promise.all(jobs);
      if (current) { setErrors(failures); setLoading(false); }
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [needle, filter, workspaceKey]);

  const results = useMemo(() => {
    const list = [...Object.values(bots), ...Object.values(historicalBots).filter(bot => bots[bot.slug]?.mainThreadId !== bot.mainThreadId)];
    const byProject = new Map([...Object.values(historicalBots), ...Object.values(bots)].map((bot) => [bot.projectId, bot]));
    const byThread = new Map(list.map(bot => [bot.mainThreadId, bot]));
    const matching = (text: string | null | undefined) => !needle || !!text?.toLowerCase().includes(needle);
    const found: Result[] = [];
    if (filter === "All" || filter === "Bots") {
      for (const bot of list) {
        const detail = (bot.mainThreadId ? previews[bot.mainThreadId]?.text : null) ?? bot.label ?? "";
        if (matching(bot.name) || matching(detail) || matching(bot.label)) found.push({ kind: "bot", key: `bot:${botReferenceKey(bot)}`, bot, detail });
      }
    }
    if (filter === "All" || filter === "Messages") {
      for (const match of matches) {
        const bot = byThread.get(match.threadId) ?? byProject.get(match.projectId);
        if (bot) found.push({ kind: "message", key: `message:${match.threadId}:${match.messageId ?? match.snippet}`, bot, detail: match.snippet, threadId: match.threadId, messageId: match.messageId });
      }
    }
    if (filter === "All" || filter === "Routines") {
      for (const task of tasks) {
        const bot = byProject.get(task.projectId);
        if (bot && (matching(task.title) || matching(task.prompt))) found.push({ kind: "routine", key: `routine:${task.id}`, bot, title: task.title, detail: bot.name });
      }
    }
    if (filter === "All" || filter === "Files") found.push(...files);
    if (filter === "All" || filter === "Apps") for (const app of apps) if (matching(app.name)) found.push({ kind: "app", key: `app:${app.id}`, title: app.name, detail: app.status === "connected" || app.status === "ready" ? "Installed app" : "Connection needed" });
    return found;
  }, [bots, historicalBots, previews, tasks, matches, files, apps, filter, needle]);

  useEffect(() => { if (q !== session.query || filter !== session.filter) setI(0); }, [q, filter, session]);
  const restoreScroll = useRef(true);
  useEffect(() => {
    if (restoreScroll.current && results.length && !loading && resultsRef.current) {
      resultsRef.current.scrollTop = session.scrollTop;
      restoreScroll.current = false;
    }
  }, [results.length, loading, session]);
  useEffect(() => { useApp.setState({ searchSession: { query: q, filter, index: i, scrollTop: resultsRef.current?.scrollTop ?? 0 } }); }, [q, filter, i]);

  useEffect(() => { resultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [i]);
  const go = (result: Result) => {
    if (result.kind === "file") { setResource(result); return; }
    if (result.kind === "app") { openDialog("connect-apps"); return; }
    if (result.kind === "message") void navigateSearchHit(result.bot, { threadId: result.threadId, messageId: result.messageId, query: needle }).catch((error: Error) => toast(error.message));
    else if (result.bot.mainThreadId) { selectThread(result.bot, result.bot.mainThreadId, true); if (result.kind === "routine") useApp.setState({ detailsOpen: true, detailsTab: "details" }); }
  };
  return (
    <Modal onClose={() => openDialog(null)} className="search-dialog mt-[-20vh] w-[560px]">
      <div className="search-field flex items-center gap-2.5 border-b border-line px-4">
        <span className="search-input flex min-w-0 flex-1 items-center gap-2.5">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setI((x) => Math.max(0, Math.min(x + 1, results.length - 1))); }
              if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
              if (e.key === "Enter" && results[i]) go(results[i]);
            }}
            placeholder="Search"
            aria-label="Search Bots and messages"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={200}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-faint"
          />
        </span>
        <button type="button" className="search-close hidden" aria-label="Close search" onClick={() => openDialog(null)}><X size={20} aria-hidden="true" /></button>
      </div>
      <div style={{ order: 1 }} className="search-filters flex gap-1.5 overflow-x-auto px-3 py-2" role="group" aria-label="Filter results">
        {FILTERS.map((name) => <button key={name} type="button" aria-pressed={filter === name} onClick={() => { setFilter(name); input.current?.focus({ preventScroll: true }); }} className={clsx("shrink-0 rounded-full px-3 py-1 text-[13px]", filter === name ? "bg-pill text-pill-fg" : "bg-hover text-muted")}>{name}</button>)}
      </div>
      <div ref={resultsRef} onScroll={(event) => useApp.setState({ searchSession: { ...useApp.getState().searchSession, scrollTop: event.currentTarget.scrollTop } })} style={{ order: 2 }} role="listbox" aria-label="Search results" className="search-results scroll-thin max-h-[380px] overflow-y-auto p-1.5">
        {loading && <p role="status" className="px-3 py-2 text-[13px] text-muted">Searching…</p>}
        {errors.length > 0 && <p role="alert" className="px-3 py-2 text-[12px] text-muted">{errors.slice(0, 3).join(" ")}</p>}
        {!loading && results.length === 0 && <div className="grid h-full min-h-[120px] place-content-center justify-items-center gap-3 py-8 text-center text-[15px] text-muted"><Search size={28} aria-hidden="true" />No matches</div>}
        {results.map((r, idx) => (
          <button key={r.key} role="option" aria-selected={idx === i} onMouseEnter={() => setI(idx)} onClick={() => go(r)} className={clsx("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left", idx === i && "bg-active")}>
            {r.kind === "app" || r.kind === "file" ? <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-hover text-muted">{r.kind === "file" ? <FileText size={16}/> : <Grid2x2Plus size={16}/>}</span> : r.kind === "routine" ? <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-hover text-muted"><Clock size={16} /></span> : <Avatar shape={r.bot.shape} color={r.bot.color} picture={r.bot.avatarImage} size={30} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px]">{"title" in r ? r.title : r.bot.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">{r.kind === "message" && <MessageSquareText size={13} className="shrink-0" />}<span className="min-w-0 truncate">{r.detail}</span></span>
            </span>
            <span className="text-[11.5px] text-faint">{r.kind === "bot" ? "Bot" : r.kind === "message" ? "Message" : r.kind === "file" ? "File" : r.kind === "app" ? "App" : "Routine"}</span>
          </button>
        ))}
      </div>
      {resource && <WorkspaceResourceViewer resource={resource.bot.mainThreadId ? { _tag: "workspace-file", threadId: resource.bot.mainThreadId, path: resource.path } : null} title={resource.title} onClose={() => setResource(null)} />}
    </Modal>
  );
}
