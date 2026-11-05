import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  Archive, ArchiveRestore, ArrowLeft, Bot as BotIcon, Box, Check, ChevronRight, Circle, CircleDot, Copy, ExternalLink, FileText, FolderGit2, FolderKanban,
  Link2, MessageSquare, MoreHorizontal, Pin, PinOff, Plus, Search, Server, Sparkles, Trash2, X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { RichMarkdown } from "./RichMarkdown";
import { Menu, Modal, Pill, Spinner, type MenuItem } from "./ui";
import { openProjects, select, selectThread, toast, useApp } from "../store";
import { chatDraft } from "../lib/chatDrafts";
import { parseThreadLink } from "../lib/botMessages";
import {
  KIND_LABEL, PRIORITIES, SETUP_REQUEST, STATUSES, STATUS_LABEL, activityText, actorName, areasOf, askAboutText, childrenOf, deleteItems, dueLabel, ensureBoard, followBoard,
  inArea, isOpenTask, itemUrl, matchesSearch, saveItems, sortItems, sortTasks, timeAgo, useBoard,
  type BoardItem, type BoardLink, type ItemInput, type Kind,
} from "../lib/projects";
import type { Bot, RunStatus, ThreadShell } from "../lib/types";
import "./projects.css";

// The Projects page: everything the user is working on, kept by them and their Bots together.
// The overview shows to-dos, projects, machines with what runs on each, what's running in T3
// right now and who changed what. Any item opens in a panel where every property is editable.

const KIND_ICON: Record<Kind, typeof Box> = { project: FolderKanban, task: CircleDot, machine: Server, service: Box, repo: FolderGit2, note: FileText, link: Link2 };
const ACTIVE_RUN: RunStatus[] = ["preparing", "queued", "starting", "running", "waiting"];

const report = (promise: Promise<unknown>) => promise.catch((error: unknown) => toast(error instanceof Error ? error.message : "Couldn't save that"));
const save = (input: ItemInput) => report(saveItems([input]));

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function readArea() {
  try { return localStorage.getItem("bot.projects.area") || null; } catch { return null; }
}

export function ProjectsPage({ narrow, onBack }: { narrow: boolean; onBack?: () => void }) {
  useEffect(() => followBoard(), []);
  const status = useBoard((s) => s.status);
  const error = useBoard((s) => s.error);
  const itemsById = useBoard((s) => s.items);
  const itemId = useApp((s) => s.projectItemId);
  const [area, setAreaState] = useState<string | null>(readArea);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<Kind | null>(null);
  const items = useMemo(() => Object.values(itemsById), [itemsById]);
  const areas = useMemo(() => areasOf(items), [items]);
  const setArea = (next: string | null) => {
    setAreaState(next);
    try { if (next) localStorage.setItem("bot.projects.area", next); else localStorage.removeItem("bot.projects.area"); } catch {}
  };
  useEffect(() => { if (area && status === "ready" && !areas.includes(area)) setArea(null); }, [area, areas, status]);
  const open = itemId ? itemsById[itemId] : undefined;

  return (
    <div className="projects-page flex min-w-0 flex-1 bg-chat">
      <section className={clsx("flex min-w-0 flex-1 flex-col", narrow && open && "hidden")} aria-label="Projects">
        <Header narrow={narrow} onBack={onBack} query={query} setQuery={setQuery} onAdd={setAdding} />
        {areas.length > 0 && <AreaTabs areas={areas} area={area} setArea={setArea} />}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {status === "loading" || status === "idle" ? <div className="grid h-40 place-items-center text-muted"><Spinner size={16} /></div>
            : status === "error" ? <div role="alert" className="m-6 rounded-2xl border border-line p-5 text-[13.5px] text-muted">{error ?? "Couldn't load the board."} <button className="underline" onClick={() => location.reload()}>Reload</button></div>
            : items.length === 0 ? <EmptyBoard onAdd={setAdding} />
            : <Overview items={items} itemsById={itemsById} area={area} query={query} narrow={narrow} />}
        </div>
      </section>
      {itemId && (open
        ? <ItemPanel key={open.id} item={open} itemsById={itemsById} narrow={narrow} />
        : status === "ready" && <MissingItem narrow={narrow} />)}
      {adding && <NewItemDialog kind={adding} area={area} onClose={() => setAdding(null)} />}
    </div>
  );
}

function Header({ narrow, onBack, query, setQuery, onAdd }: { narrow: boolean; onBack?: () => void; query: string; setQuery: (q: string) => void; onAdd: (kind: Kind) => void }) {
  const live = useBoard((s) => s.live);
  const status = useBoard((s) => s.status);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const addItems: MenuItem[] = (["project", "task", "machine", "service", "repo", "note", "link"] as Kind[]).map((kind) => {
    const Icon = KIND_ICON[kind];
    return { label: KIND_LABEL[kind], icon: <Icon size={14} />, onSelect: () => onAdd(kind) };
  });
  return (
    <header className="projects-header flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-2 sm:px-6">
      {onBack && <button className="-ml-2 grid size-10 place-items-center rounded-full hover:bg-hover" aria-label="Back" onClick={onBack}><ArrowLeft size={20} /></button>}
      <h1 className="text-[20px] font-semibold tracking-tight">Projects</h1>
      <span className={clsx("projects-live ml-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px]", live ? "text-muted" : "text-faint")} title={live ? "Changes from you and your Bots appear as they happen" : "Reconnecting…"}>
        <span className={clsx("size-1.5 rounded-full", live ? "bg-success projects-live-dot" : "bg-faint")} />{status === "ready" ? (live ? "Live" : "Reconnecting") : ""}
      </span>
      <div className={clsx("flex min-w-0 items-center gap-2", narrow ? "order-last w-full" : "ml-auto")}>
        <label className={clsx("relative flex items-center", narrow ? "min-w-0 flex-1" : "w-[240px]")}>
          <Search size={14} className="pointer-events-none absolute left-3 text-faint" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search the board" className="h-8 w-full rounded-full border border-line bg-transparent pr-3 pl-8 text-[13.5px] outline-none focus:border-line-strong" />
        </label>
        <Pill onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 180, y: r.bottom + 6 }); }} aria-label="Add to the board"><Plus size={14} />{!narrow && "Add"}</Pill>
      </div>
      {menu && <Menu items={addItems} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </header>
  );
}

function AreaTabs({ areas, area, setArea }: { areas: string[]; area: string | null; setArea: (a: string | null) => void }) {
  return (
    <nav className="projects-areas flex shrink-0 gap-1 overflow-x-auto px-4 pb-2 sm:px-6" aria-label="Areas">
      {[null, ...areas].map((a) => (
        <button key={a ?? "all"} aria-pressed={area === a} onClick={() => setArea(a)} className={clsx("h-7 shrink-0 rounded-full px-3 text-[12.5px] capitalize transition-colors", area === a ? "bg-pill text-pill-fg" : "bg-pill-soft text-fg hover:bg-active")}>{a ?? "All"}</button>
      ))}
    </nav>
  );
}

// ---------- overview ----------

function Overview({ items, itemsById, area, query, narrow }: { items: BoardItem[]; itemsById: Record<string, BoardItem>; area: string | null; query: string; narrow: boolean }) {
  const shown = items.filter((item) => !item.archived && inArea(item, area, itemsById) && matchesSearch(item, query));
  const searching = query.trim().length > 0;
  const tasks = sortTasks(shown.filter(isOpenTask));
  const projects = sortItems(shown.filter((item) => item.kind === "project"));
  // Machines are shared by every area; a search still narrows them.
  const machines = sortItems(items.filter((item) => item.kind === "machine" && !item.archived && (!searching || matchesSearch(item, query) || items.some((child) => child.machineId === item.id && !child.archived && matchesSearch(child, query)))));
  const loose = sortItems(shown.filter((item) => ["service", "repo"].includes(item.kind) && !item.machineId));
  const notes = sortItems(shown.filter((item) => ["note", "link"].includes(item.kind) && !item.parentId));
  const pinned = sortItems(shown.filter((item) => item.pinned && item.kind !== "task"));
  const archivedCount = items.filter((item) => item.archived).length;
  const doneRecently = items.filter((item) => item.kind === "task" && item.status === "done" && !item.archived && inArea(item, area, itemsById) && item.doneAt && Date.now() - Date.parse(item.doneAt) < 7 * 86_400_000);
  const nothing = searching && !tasks.length && !projects.length && !machines.length && !loose.length && !notes.length;
  return (
    <div className={clsx("projects-overview mx-auto w-full max-w-[1180px] px-4 pt-2 pb-16 sm:px-6", !narrow && "projects-grid")}>
      {nothing && <p role="status" className="projects-span py-10 text-center text-[13.5px] text-muted">Nothing on the board matches “{query.trim()}”.</p>}
      {pinned.length > 0 && <div className="projects-span flex flex-wrap gap-2">{pinned.map((item) => <PinnedCard key={item.id} item={item} itemsById={itemsById} />)}</div>}
      {(!searching || tasks.length > 0) && <Panel title="To do" count={tasks.length} className="projects-tasks">
        <ul>{tasks.map((task) => <TaskRow key={task.id} item={task} itemsById={itemsById} showProject />)}</ul>
        {!searching && <QuickAdd kind="task" area={area} placeholder="Add a to-do" />}
        {doneRecently.length > 0 && <DoneRecently tasks={doneRecently} itemsById={itemsById} />}
      </Panel>}
      {(!searching || projects.length > 0) && <Panel title="Projects" count={projects.length} className="projects-projects">
        <ul>{projects.map((project) => <ProjectRow key={project.id} item={project} items={items} />)}</ul>
        {!searching && <QuickAdd kind="project" area={area} placeholder="New project" />}
      </Panel>}
      {(!searching || machines.length > 0 || loose.length > 0) && <Panel title="Machines" count={machines.length} className="projects-span" action={!searching ? <QuickAddButton kind="machine" label="Add machine" area={null} /> : undefined}>
        {machines.length === 0 && loose.length === 0 && <p className="px-1 py-2 text-[13px] text-muted">Add the computers and servers you work on, or ask a Bot to find them. What runs on each goes underneath.</p>}
        <div className="projects-machines">{machines.map((machine) => <MachineCard key={machine.id} item={machine} items={items} />)}</div>
        {loose.length > 0 && <div className="mt-3"><div className="px-1 pb-1 text-[12px] text-muted">Not on a machine yet</div><ul>{loose.map((item) => <ItemRow key={item.id} item={item} itemsById={itemsById} />)}</ul></div>}
      </Panel>}
      {!searching && <RunningNow items={items} />}
      {(!searching || notes.length > 0) && notes.length > 0 && <Panel title="Notes and links" count={notes.length}>
        <ul>{notes.map((item) => <ItemRow key={item.id} item={item} itemsById={itemsById} />)}</ul>
      </Panel>}
      {!searching && <ActivityPanel />}
      {!searching && archivedCount > 0 && <ArchivedList items={items.filter((item) => item.archived)} itemsById={itemsById} />}
    </div>
  );
}

function Panel({ title, count, children, className, action }: { title: string; count?: number; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={clsx("projects-panel", className)} aria-label={title}>
      <div className="flex h-9 items-center gap-2 px-1">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {count !== undefined && count > 0 && <span className="text-[12px] text-faint tabular-nums">{count}</span>}
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

function FlashTag({ id }: { id: string }) {
  const flash = useBoard((s) => s.flashes[id]);
  return flash ? <span className="projects-flash-tag" aria-live="polite">{flash.who}</span> : null;
}
const useFlash = (id: string) => useBoard((s) => Boolean(s.flashes[id]));

function StatusDot({ kind, status }: { kind: Kind; status?: string }) {
  const tone = status === "running" || status === "online" || status === "active" || status === "doing" ? "ok"
    : status === "failing" ? "bad"
    : status === "offline" || status === "stopped" || status === "done" || status === "archived" || status === "paused" || status === "waiting" ? "off"
    : "unknown";
  return <span className={clsx("projects-dot", `projects-dot-${tone}`)} title={status ? `${KIND_LABEL[kind]}: ${STATUS_LABEL[status] ?? status}` : undefined} aria-hidden="true" />;
}

function TaskCheck({ item }: { item: BoardItem }) {
  const done = item.status === "done";
  return (
    <button
      role="checkbox" aria-checked={done} aria-label={done ? `Mark “${item.title}” not done` : `Mark “${item.title}” done`}
      onClick={(e) => { e.stopPropagation(); void save({ id: item.id, status: done ? "todo" : "done" }); }}
      className={clsx("projects-check grid size-[18px] shrink-0 place-items-center rounded-full border", done ? "border-transparent bg-fg text-chat" : "border-line-strong hover:border-fg")}
    >{done && <Check size={12} strokeWidth={3} />}</button>
  );
}

function TaskRow({ item, itemsById, showProject = false }: { item: BoardItem; itemsById: Record<string, BoardItem>; showProject?: boolean }) {
  const flashing = useFlash(item.id);
  const due = dueLabel(item.fields.due);
  const parent = showProject && item.parentId ? itemsById[item.parentId] : undefined;
  const running = useLinkedActivity(item);
  return (
    <li className={clsx("projects-row group", flashing && "projects-flash", item.status === "done" && "projects-row-done")}>
      <TaskCheck item={item} />
      <button className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left" onClick={() => openProjects(item.id)}>
        <span className="min-w-[4ch] truncate text-[13.5px]">{item.title}</span>
        {item.fields.priority === "high" && <span className="projects-chip projects-chip-high">High</span>}
        {item.status === "doing" && <span className="projects-chip">Doing</span>}
        {item.status === "waiting" && <span className="projects-chip">Waiting</span>}
        {running && <RunBadge state={running} />}
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-muted">
        <FlashTag id={item.id} />
        {parent && <button className="projects-meta-link projects-row-parent max-w-[150px] truncate" onClick={() => openProjects(parent.id)}>{parent.title}</button>}
        {due && <span className={clsx(due.tone === "late" && "text-danger", due.tone === "soon" && "text-fg")}>{due.text}</span>}
      </span>
    </li>
  );
}

function DoneRecently({ tasks, itemsById }: { tasks: BoardItem[]; itemsById: Record<string, BoardItem> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button className="flex h-8 items-center gap-1 px-1 text-[12.5px] text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={clsx("transition", open && "rotate-90")} /> Done this week {tasks.length}
      </button>
      {open && <ul>{[...tasks].sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "")).map((task) => <TaskRow key={task.id} item={task} itemsById={itemsById} showProject />)}</ul>}
    </div>
  );
}

function ProjectRow({ item, items }: { item: BoardItem; items: BoardItem[] }) {
  const flashing = useFlash(item.id);
  const tasks = items.filter((t) => t.kind === "task" && t.parentId === item.id && !t.archived);
  const open = tasks.filter((t) => t.status !== "done").length;
  const done = tasks.length - open;
  const running = useLinkedActivity(item, items);
  return (
    <li className={clsx("projects-row", flashing && "projects-flash")}>
      <StatusDot kind="project" status={item.status} />
      <button className="flex min-w-0 flex-1 flex-col text-left" onClick={() => openProjects(item.id)}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13.5px] font-medium">{item.title}</span>
          {item.status && item.status !== "active" && <span className="projects-chip">{STATUS_LABEL[item.status]}</span>}
          {running && <RunBadge state={running} />}
        </span>
        <span className="truncate text-[12px] text-muted">
          {[item.area, tasks.length ? `${open} open${done ? ` · ${done} done` : ""}` : "No to-dos", `${actorName(item.updatedBy)} · ${timeAgo(item.updatedAt)}`].filter(Boolean).join(" · ")}
        </span>
      </button>
      <FlashTag id={item.id} />
      {tasks.length > 0 && <span className="projects-progress" aria-label={`${done} of ${tasks.length} to-dos done`}><span style={{ width: `${Math.round((done / tasks.length) * 100)}%` }} /></span>}
    </li>
  );
}

function ItemRow({ item, itemsById, hideParent = false }: { item: BoardItem; itemsById: Record<string, BoardItem>; hideParent?: boolean }) {
  const flashing = useFlash(item.id);
  const Icon = KIND_ICON[item.kind];
  const parent = !hideParent && item.parentId ? itemsById[item.parentId] : undefined;
  if (item.kind === "task") return <TaskRow item={item} itemsById={itemsById} />;
  return (
    <li className={clsx("projects-row", flashing && "projects-flash")}>
      {item.kind === "service" ? <StatusDot kind="service" status={item.status} /> : <Icon size={14} className="shrink-0 text-muted" />}
      <button className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left" onClick={() => openProjects(item.id)} title={item.fields.path ?? item.fields.host ?? undefined}>
        <span className="min-w-0 shrink-[0.2] truncate text-[13.5px]">{item.title}</span>
        <ItemFacts item={item} />
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-muted">
        <FlashTag id={item.id} />
        {parent && <span className="projects-row-parent max-w-[150px] truncate">{parent.title}</span>}
        {item.fields.url && <a href={item.fields.url} target="_blank" rel="noreferrer" className="grid size-6 place-items-center rounded-full hover:bg-hover" aria-label={`Open ${item.title}`} onClick={(e) => e.stopPropagation()}><ExternalLink size={13} /></a>}
      </span>
    </li>
  );
}

/** Ports, branches and paths, the facts that tell services and repos apart at a glance. */
function ItemFacts({ item }: { item: BoardItem }) {
  const facts = [item.fields.port ? `:${item.fields.port}` : null, item.fields.branch ?? null].filter(Boolean);
  return facts.length ? <span className="min-w-0 truncate font-mono text-[11.5px] text-muted">{facts.join("  ")}</span> : null;
}

function PinnedCard({ item, itemsById }: { item: BoardItem; itemsById: Record<string, BoardItem> }) {
  const Icon = KIND_ICON[item.kind];
  const flashing = useFlash(item.id);
  const open = Object.values(itemsById).filter((t) => isOpenTask(t) && t.parentId === item.id).length;
  return (
    <button onClick={() => openProjects(item.id)} className={clsx("projects-pinned flex min-w-[180px] max-w-[280px] items-center gap-2.5 rounded-2xl border border-line px-3 py-2.5 text-left hover:bg-hover", flashing && "projects-flash")}>
      <Icon size={16} className="shrink-0 text-muted" />
      <span className="min-w-0"><span className="block truncate text-[13.5px] font-medium">{item.title}</span><span className="block truncate text-[12px] text-muted">{item.kind === "project" ? `${open} open` : KIND_LABEL[item.kind]}</span></span>
      <Pin size={12} className="ml-auto shrink-0 text-faint" />
    </button>
  );
}

function MachineCard({ item, items }: { item: BoardItem; items: BoardItem[] }) {
  const flashing = useFlash(item.id);
  const itemsById = useBoard((s) => s.items);
  const on = sortItems(items.filter((child) => child.machineId === item.id && !child.archived));
  const services = on.filter((child) => child.kind === "service");
  const repos = on.filter((child) => child.kind === "repo");
  return (
    <article className={clsx("projects-machine", flashing && "projects-flash")}>
      <button className="flex w-full items-center gap-2 text-left" onClick={() => openProjects(item.id)}>
        <Server size={15} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{item.title}</span>
        <FlashTag id={item.id} />
        <span className="flex items-center gap-1.5 text-[12px] text-muted"><StatusDot kind="machine" status={item.status} />{STATUS_LABEL[item.status ?? "unknown"]}</span>
      </button>
      {item.fields.host && <div className="mt-0.5 truncate pl-[23px] font-mono text-[11.5px] text-muted">{item.fields.host}</div>}
      {on.length === 0 ? <p className="mt-2 pl-[23px] text-[12.5px] text-faint">Nothing listed here yet.</p> : <>
        {services.length > 0 && <ul className="mt-2">{services.map((service) => <ItemRow key={service.id} item={service} itemsById={itemsById} />)}</ul>}
        {repos.length > 0 && <ul className={services.length ? "mt-1 border-t border-line pt-1" : "mt-2"}>{repos.map((repo) => <ItemRow key={repo.id} item={repo} itemsById={itemsById} />)}</ul>}
      </>}
    </article>
  );
}

// ---------- live T3 state ----------

type RunState = "running" | "waiting";
function threadState(thread: ThreadShell | undefined): RunState | null {
  if (!thread || thread.archivedAt) return null;
  if (thread.pendingRuntimeRequest?.blocking) return "waiting";
  const status = thread.activityRunStatus ?? thread.status;
  if (status === "waiting") return "waiting";
  return ACTIVE_RUN.includes(status) ? "running" : null;
}

/** Whether a thread linked to this item (or to any of its children) is running right now. */
function useLinkedActivity(item: BoardItem, items?: BoardItem[]): RunState | null {
  const threads = useApp((s) => s.threads);
  const ids = [item, ...(items ?? []).filter((child) => child.parentId === item.id)].flatMap((it) => it.links.filter((link) => link.type === "thread" && !link.environmentId).map((link) => (link as { threadId: string }).threadId));
  const states = ids.map((id) => threadState(threads[id]));
  return states.includes("waiting") ? "waiting" : states.includes("running") ? "running" : null;
}

function RunBadge({ state }: { state: RunState }) {
  return <span className={clsx("projects-run", state === "waiting" && "projects-run-waiting")}>{state === "waiting" ? "Needs you" : "Working"}</span>;
}

function RunningNow({ items }: { items: BoardItem[] }) {
  const threads = useApp((s) => s.threads);
  const projects = useApp((s) => s.projects);
  const bots = useApp((s) => s.bots);
  const now = useNow();
  const active = Object.values(threads).map((thread) => ({ thread, state: threadState(thread) })).filter((row): row is { thread: ThreadShell; state: RunState } => row.state !== null);
  const roots = active.filter((row) => !row.thread.lineage.parentThreadId || !threads[row.thread.lineage.parentThreadId]);
  const helpers = (id: string) => active.filter((row) => row.thread.lineage.rootThreadId === id && row.thread.id !== id).length;
  roots.sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || (b.thread.latestRunStartedAt ?? "").localeCompare(a.thread.latestRunStartedAt ?? ""));
  return (
    <Panel title="Running now" count={roots.length} className="projects-running">
      {roots.length === 0 ? <p className="px-1 py-2 text-[13px] text-muted">Nothing is running in T3 on this server.</p> : <ul>
        {roots.map(({ thread, state }) => {
          const owner = Object.values(bots).find((bot) => bot.projectId === thread.projectId);
          const linked = items.filter((item) => !item.archived && item.links.some((link) => link.type === "thread" && !link.environmentId && link.threadId === thread.id));
          const extra = helpers(thread.id);
          return (
            <li key={thread.id} className="projects-row">
              {owner ? <Avatar shape={owner.shape} color={owner.color} picture={owner.avatarImage} size={20} state={state === "waiting" ? "waiting" : "working"} /> : <span className={clsx("projects-dot", state === "waiting" ? "projects-dot-wait" : "projects-dot-ok", "projects-live-dot")} aria-hidden="true" />}
              <button className="flex min-w-0 flex-1 flex-col text-left" disabled={!owner} onClick={() => owner && selectThread(owner, thread.id)}>
                <span className="min-w-0 truncate text-[13.5px]">{thread.title || "Untitled thread"}</span>
                <span className="truncate text-[12px] text-muted">{[owner?.name ?? projects[thread.projectId]?.title, extra ? `${extra} helper${extra === 1 ? "" : "s"}` : null, thread.latestRunStartedAt ? `started ${timeAgo(thread.latestRunStartedAt, now)}` : null].filter(Boolean).join(" · ")}</span>
              </button>
              {linked[0] && <button className="projects-meta-link hidden max-w-[160px] truncate text-[12px] text-muted sm:inline" onClick={() => openProjects(linked[0].id)}>{linked[0].title}</button>}
              <RunBadge state={state} />
            </li>
          );
        })}
      </ul>}
      <p className="px-1 pt-1 text-[11.5px] text-faint">Live from T3. Bots keep other machines up to date on the board.</p>
    </Panel>
  );
}

function ActivityPanel() {
  const activity = useBoard((s) => s.activity);
  const items = useBoard((s) => s.items);
  const now = useNow();
  const recent = activity.slice(-12).reverse();
  if (!recent.length) return null;
  return (
    <Panel title="Recent changes" className="projects-activity">
      <ul>{recent.map((entry) => (
        <li key={entry.seq} className="flex items-baseline gap-2 px-1 py-1.5 text-[12.5px]">
          {entry.actor.type === "bot" ? <BotIcon size={12} className="shrink-0 translate-y-[1px] text-muted" /> : <Circle size={8} className="mx-[2px] shrink-0 text-faint" />}
          {items[entry.itemId] && entry.action !== "deleted"
            ? <button className="min-w-0 flex-1 truncate text-left text-muted hover:text-fg" onClick={() => openProjects(entry.itemId)}>{activityText(entry)}</button>
            : <span className="min-w-0 flex-1 truncate text-muted">{activityText(entry)}</span>}
          <span className="shrink-0 text-[11.5px] text-faint">{timeAgo(entry.at, now)}</span>
        </li>
      ))}</ul>
    </Panel>
  );
}

function ArchivedList({ items, itemsById }: { items: BoardItem[]; itemsById: Record<string, BoardItem> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="projects-span">
      <button className="flex h-8 items-center gap-1 px-1 text-[12.5px] text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={clsx("transition", open && "rotate-90")} /> Archived {items.length}
      </button>
      {open && <ul className="opacity-80">{sortItems(items).map((item) => <ItemRow key={item.id} item={item} itemsById={itemsById} />)}</ul>}
    </div>
  );
}

// ---------- adding ----------

function QuickAdd({ kind, area, parentId, machineId, placeholder }: { kind: Kind; area: string | null; parentId?: string; machineId?: string; placeholder: string }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await saveItems([{ kind, title: value, ...(parentId ? { parentId } : area ? { area } : {}), ...(machineId ? { machineId } : {}) }]);
      setTitle("");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't add that");
    } finally { setBusy(false); }
  };
  return (
    <form className="projects-quick-add flex items-center gap-2.5 px-1" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Plus size={15} className="shrink-0 text-faint" />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={placeholder} aria-label={placeholder} disabled={busy} className="h-9 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint" />
    </form>
  );
}

function QuickAddButton({ kind, label, area }: { kind: Kind; label: string; area: string | null }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="flex h-7 items-center gap-1 rounded-full px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg" onClick={() => setOpen(true)}><Plus size={13} />{label}</button>
    {open && <NewItemDialog kind={kind} area={area} onClose={() => setOpen(false)} />}
  </>;
}

function NewItemDialog({ kind, area, parentId, machineId, onClose }: { kind: Kind; area: string | null; parentId?: string; machineId?: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const [item] = await saveItems([{ kind, title: title.trim(), ...(parentId ? { parentId } : area && kind !== "machine" ? { area } : {}), ...(machineId ? { machineId } : {}) }]);
      onClose();
      openProjects(item.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't add that");
      setBusy(false);
    }
  };
  const examples: Record<Kind, string> = { project: "Threebot launch", task: "Renew the domain", machine: "MacBook Air", service: "bot-gateway", repo: "RokaSwK/threebot", note: "How the NAS is set up", link: "Cloudflare dashboard" };
  return (
    <Modal title={`New ${KIND_LABEL[kind].toLowerCase()}`} onClose={onClose} className="w-[400px] max-w-full">
      <form className="p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={examples[kind]} aria-label="Title" className="h-10 w-full rounded-xl border border-line bg-transparent px-3 text-[16px] outline-none focus:border-line-strong" />
        <p className="mt-2 text-[12.5px] text-muted">You can add details after, or ask a Bot to fill them in.</p>
        {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Pill variant="soft" onClick={onClose} disabled={busy}>Cancel</Pill>
          <Pill type="submit" disabled={busy || !title.trim()}>{busy && <Spinner />}Add</Pill>
        </div>
      </form>
    </Modal>
  );
}

function EmptyBoard({ onAdd }: { onAdd: (kind: Kind) => void }) {
  const bots = useApp((s) => s.bots);
  const main = Object.values(bots).find((bot) => bot.primary && !bot.hidden) ?? Object.values(bots).find((bot) => !bot.hidden);
  return (
    <div className="mx-auto flex max-w-[460px] flex-col items-center px-6 pt-16 pb-10 text-center">
      {main ? <Avatar shape={main.shape} color={main.color} picture={main.avatarImage} size={64} state="happy" /> : <FolderKanban size={40} className="text-muted" />}
      <h2 className="mt-5 text-[20px] font-semibold tracking-tight">One place for everything you're on</h2>
      <p className="mt-2 text-[14px] text-muted">Projects, to-dos, your machines and what runs on each, repos and links. You and your Bots keep it up to date together, and every change shows up here as it happens.</p>
      {main && <Pill className="mt-6 h-10 px-5 text-[14px]" onClick={() => askBot(main, SETUP_REQUEST)}><Sparkles size={15} />Ask {main.name} to set it up</Pill>}
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <Pill variant="soft" onClick={() => onAdd("project")}>Add a project</Pill>
        <Pill variant="soft" onClick={() => onAdd("task")}>Add a to-do</Pill>
        <Pill variant="soft" onClick={() => onAdd("machine")}>Add a machine</Pill>
      </div>
    </div>
  );
}

/** Put a message in a Bot's composer and open its chat, so the user can send or edit it. */
function askBot(bot: Bot, text: string) {
  chatDraft(bot, bot.mainThreadId).setText(text);
  select(bot.slug);
}

// ---------- one item ----------

function MissingItem({ narrow }: { narrow: boolean }) {
  return (
    <aside className={clsx("projects-item-panel grid place-items-center p-8 text-center", narrow ? "projects-item-sheet" : "")}>
      <div>
        <p className="text-[14px]">That item isn't on the board anymore.</p>
        <Pill variant="soft" className="mt-3" onClick={() => openProjects(null)}>Back to Projects</Pill>
      </div>
    </aside>
  );
}

const FIELDS_FOR: Record<Kind, (keyof BoardItem["fields"])[]> = {
  project: ["due", "owner", "url", "path", "tags"],
  task: ["due", "priority", "owner", "url", "tags"],
  machine: ["host", "url", "tags"],
  service: ["host", "port", "url", "path", "tags"],
  repo: ["branch", "path", "url", "tags"],
  note: ["url", "tags"],
  link: ["url", "tags"],
};
const FIELD_LABEL: Record<string, string> = { due: "Due", priority: "Priority", owner: "Owner", url: "Address", path: "Path", host: "Host", port: "Port", branch: "Branch", tags: "Tags" };

function ItemPanel({ item, itemsById, narrow }: { item: BoardItem; itemsById: Record<string, BoardItem>; narrow: boolean }) {
  const bots = useApp((s) => s.bots);
  const flashing = useFlash(item.id);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const items = Object.values(itemsById);
  const children = sortItems(childrenOf(items, item.id));
  const childTasks = sortTasks(children.filter((child) => child.kind === "task"));
  const childOther = children.filter((child) => child.kind !== "task");
  const onMachine = item.kind === "machine" ? sortItems(items.filter((child) => child.machineId === item.id && !child.archived)) : [];
  const linkedFrom = items.filter((other) => other.links.some((link) => link.type === "item" && link.id === item.id));
  const Icon = KIND_ICON[item.kind];
  const close = () => openProjects(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(itemUrl(item.id)); toast("Link copied"); } catch { toast(itemUrl(item.id)); }
  };
  const visibleBots = Object.values(bots).filter((bot) => !bot.hidden).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  const askMenu = (x: number, y: number) => setMenu({ x, y, items: visibleBots.map((bot) => ({ label: bot.name, icon: <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={16} />, onSelect: () => askBot(bot, askAboutText(item)) })) });
  const moreMenu = (x: number, y: number) => setMenu({ x, y, items: [
    { label: item.pinned ? "Unpin" : "Pin to top", icon: item.pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => void save({ id: item.id, pinned: !item.pinned }) },
    { label: "Copy link", icon: <Copy size={14} />, onSelect: () => void copy() },
    { label: "Change kind", icon: <Box size={14} />, items: (Object.keys(KIND_LABEL) as Kind[]).filter((kind) => kind !== item.kind).map((kind) => ({ label: KIND_LABEL[kind], onSelect: () => void save({ id: item.id, kind }) })) },
    "divider",
    { label: item.archived ? "Restore" : "Archive", icon: item.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />, onSelect: () => void save({ id: item.id, archived: !item.archived }) },
    { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmDelete(true) },
  ] });
  return (
    <aside className={clsx("projects-item-panel flex min-w-0 flex-col", narrow ? "projects-item-sheet" : "", flashing && "projects-flash")} aria-label={item.title}>
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-3">
        <button className="grid size-9 place-items-center rounded-full hover:bg-hover" aria-label={narrow ? "Back" : "Close"} onClick={narrow ? () => history.back() : close}>{narrow ? <ArrowLeft size={19} /> : <X size={17} />}</button>
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted"><Icon size={14} />{KIND_LABEL[item.kind]}{item.archived && " · Archived"}</span>
        <FlashTag id={item.id} />
        <div className="ml-auto flex items-center gap-1">
          {visibleBots.length > 0 && <Pill variant="soft" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); askMenu(r.right - 200, r.bottom + 6); }}><MessageSquare size={14} />Ask a Bot</Pill>}
          <button className="grid size-9 place-items-center rounded-full hover:bg-hover" aria-label="Copy link" title="Copy link" onClick={() => void copy()}><Link2 size={16} /></button>
          <button className="grid size-9 place-items-center rounded-full hover:bg-hover" aria-label="More" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); moreMenu(r.right - 200, r.bottom + 6); }}><MoreHorizontal size={17} /></button>
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-12">
        <div className="flex items-start gap-3 pt-1">
          {item.kind === "task" && <span className="pt-[7px]"><TaskCheck item={item} /></span>}
          <TitleEditor item={item} />
        </div>
        {STATUSES[item.kind].length > 0 && <StatusPicker item={item} />}
        <Properties item={item} items={items} />
        <Body item={item} />
        {(item.kind === "project" || childTasks.length > 0) && <section className="mt-6" aria-label="To-dos">
          <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">To-dos{childTasks.length ? ` · ${childTasks.filter((t) => t.status !== "done").length} open` : ""}</h3>
          <ul>{childTasks.map((task) => <TaskRow key={task.id} item={task} itemsById={itemsById} />)}</ul>
          <QuickAdd kind="task" area={null} parentId={item.id} placeholder="Add a to-do" />
        </section>}
        {item.kind === "machine" && <section className="mt-6" aria-label="On this machine">
          <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">On this machine</h3>
          <ul>{onMachine.map((child) => <ItemRow key={child.id} item={child} itemsById={itemsById} />)}</ul>
          <QuickAdd kind="service" area={null} machineId={item.id} placeholder="Add something that runs here" />
        </section>}
        {childOther.length > 0 && <section className="mt-6" aria-label="Inside">
          <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">Also in here</h3>
          <ul>{childOther.map((child) => <ItemRow key={child.id} item={child} itemsById={itemsById} hideParent />)}</ul>
        </section>}
        <Links item={item} itemsById={itemsById} />
        {linkedFrom.length > 0 && <section className="mt-6" aria-label="Linked from">
          <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-muted">Linked from</h3>
          <ul>{linkedFrom.map((other) => <ItemRow key={other.id} item={other} itemsById={itemsById} />)}</ul>
        </section>}
        <p className="mt-8 px-1 text-[11.5px] text-faint">Added by {actorName(item.createdBy)} · {timeAgo(item.createdAt)}{item.updatedAt !== item.createdAt ? ` · changed by ${actorName(item.updatedBy)} · ${timeAgo(item.updatedAt)}` : ""}</p>
      </div>
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {confirmDelete && <Modal title={`Delete “${item.title}”`} onClose={() => setConfirmDelete(false)} className="w-[380px] max-w-full">
        <div className="p-4 text-[13.5px] text-muted">{children.length || onMachine.length ? "What's inside it stays on the board and moves up a level. " : ""}Archive it instead if you might want it back.</div>
        <div className="flex justify-end gap-2 border-t border-line p-3">
          <Pill variant="soft" onClick={() => setConfirmDelete(false)}>Cancel</Pill>
          <Pill variant="soft" onClick={() => { setConfirmDelete(false); void save({ id: item.id, archived: true }); }}>Archive</Pill>
          <Pill variant="danger" onClick={() => { setConfirmDelete(false); void report(deleteItems([item.id]).then(close)); }}>Delete</Pill>
        </div>
      </Modal>}
    </aside>
  );
}

/** Text that saves when you leave it. A Bot's newer value replaces it unless you're typing. */
function useDraft(value: string, commit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return {
    draft, editing, setDraft,
    focus: () => setEditing(true),
    blur: () => { setEditing(false); if (draft.trim() !== value.trim()) commit(draft); },
    reset: () => { setDraft(value); setEditing(false); },
  };
}

function TitleEditor({ item }: { item: BoardItem }) {
  const title = useDraft(item.title, (next) => { if (next.trim()) void save({ id: item.id, title: next }); else title.reset(); });
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "0px"; el.style.height = `${el.scrollHeight}px`; }
  }, [title.draft]);
  return (
    <textarea
      ref={ref} rows={1} value={title.draft} aria-label="Title"
      onFocus={title.focus} onBlur={title.blur} onChange={(e) => title.setDraft(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } if (e.key === "Escape") { title.reset(); e.currentTarget.blur(); } }}
      className={clsx("projects-title min-w-0 flex-1 resize-none bg-transparent text-[22px] leading-[30px] font-semibold tracking-tight outline-none", item.status === "done" && "text-muted line-through")}
    />
  );
}

function StatusPicker({ item }: { item: BoardItem }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1" role="radiogroup" aria-label="Status">
      {STATUSES[item.kind].map((status) => (
        <button key={status} role="radio" aria-checked={item.status === status} onClick={() => void save({ id: item.id, status })}
          className={clsx("flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-colors", item.status === status ? "bg-pill text-pill-fg" : "bg-pill-soft hover:bg-active")}>
          {item.status !== status && <StatusDot kind={item.kind} status={status} />}{STATUS_LABEL[status]}
        </button>
      ))}
    </div>
  );
}

function Properties({ item, items }: { item: BoardItem; items: BoardItem[] }) {
  const areas = areasOf(items);
  const parents = sortItems(items.filter((other) => other.id !== item.id && !other.archived && (other.kind === "project" || other.id === item.parentId)));
  const machines = sortItems(items.filter((other) => other.kind === "machine" && !other.archived && other.id !== item.id));
  const area = useDraft(item.area ?? "", (next) => void save({ id: item.id, area: next.trim() || null }));
  return (
    <dl className="projects-props mt-5">
      {item.kind !== "machine" && <Prop label="Part of">
        <select value={item.parentId ?? ""} onChange={(e) => void save({ id: item.id, parentId: e.target.value || null })} className={clsx("projects-input", !item.parentId && "text-faint")} aria-label="Part of">
          <option value="">Top level</option>
          {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
        </select>
      </Prop>}
      {(item.kind === "service" || item.kind === "repo") && <Prop label="Machine">
        <select value={item.machineId ?? ""} onChange={(e) => void save({ id: item.id, machineId: e.target.value || null })} className={clsx("projects-input", !item.machineId && "text-faint")} aria-label="Machine">
          <option value="">Not set</option>
          {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.title}</option>)}
        </select>
      </Prop>}
      {(!item.parentId || item.area) && <Prop label="Area">
        <input list="projects-areas" value={area.draft} placeholder="Not set" onFocus={area.focus} onBlur={area.blur} onChange={(e) => area.setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} className="projects-input" aria-label="Area" />
        <datalist id="projects-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
      </Prop>}
      {FIELDS_FOR[item.kind].map((field) => <FieldEditor key={field} item={item} field={field} />)}
    </dl>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return <div className="projects-prop"><dt>{label}</dt><dd>{children}</dd></div>;
}

function FieldEditor({ item, field }: { item: BoardItem; field: keyof BoardItem["fields"] }) {
  const raw = item.fields[field];
  const value = Array.isArray(raw) ? raw.join(", ") : raw === undefined ? "" : String(raw);
  const commit = (next: string) => {
    const trimmed = next.trim();
    const parsed = !trimmed ? null : field === "port" ? Number(trimmed) : field === "tags" ? trimmed.split(/[,\s]+/).filter(Boolean) : trimmed;
    void save({ id: item.id, fields: { [field]: parsed } });
  };
  const draft = useDraft(value, commit);
  if (field === "priority") return <Prop label={FIELD_LABEL[field]}>
    <select value={item.fields.priority ?? "normal"} onChange={(e) => void save({ id: item.id, fields: { priority: e.target.value === "normal" ? null : e.target.value as BoardItem["fields"]["priority"] } })} className="projects-input" aria-label="Priority">
      {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
    </select>
  </Prop>;
  if (field === "due") return <Prop label={FIELD_LABEL[field]}>
    <input type="date" value={item.fields.due ?? ""} onChange={(e) => void save({ id: item.id, fields: { due: e.target.value || null } })} className={clsx("projects-input", !item.fields.due && "projects-input-empty")} aria-label="Due date" />
  </Prop>;
  const mono = field === "path" || field === "host" || field === "branch" || field === "port";
  return <Prop label={FIELD_LABEL[field]}>
    <span className="flex min-w-0 items-center gap-1">
      <input value={draft.draft} inputMode={field === "port" ? "numeric" : undefined} placeholder={field === "url" ? "https://" : field === "tags" ? "comma separated" : "Not set"}
        onFocus={draft.focus} onBlur={draft.blur} onChange={(e) => draft.setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { draft.reset(); e.currentTarget.blur(); } }}
        className={clsx("projects-input", mono && draft.draft && "font-mono text-[12.5px]")} aria-label={FIELD_LABEL[field]} />
      {field === "url" && item.fields.url && <a href={item.fields.url} target="_blank" rel="noreferrer" className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-hover" aria-label="Open address"><ExternalLink size={13} /></a>}
    </span>
  </Prop>;
}

function Body({ item }: { item: BoardItem }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.body ?? "");
  const bots = useApp((s) => s.bots);
  const ref = useRef<HTMLTextAreaElement>(null);
  const startedFrom = useRef(item.body ?? "");
  useEffect(() => { if (!editing) setDraft(item.body ?? ""); }, [item.body, editing]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "0px"; el.style.height = `${Math.max(el.scrollHeight, 120)}px`; } }, [draft, editing]);
  const finish = () => {
    setEditing(false);
    if (draft.trim() !== (item.body ?? "").trim()) void save({ id: item.id, body: draft });
  };
  const changedMeanwhile = editing && (item.body ?? "") !== startedFrom.current;
  return (
    <section className="mt-6" aria-label="Notes">
      <h3 className="mb-1 flex items-center px-1 text-[12.5px] font-semibold text-muted">Notes{!editing && <button className="ml-auto text-[12px] font-normal hover:text-fg" onClick={() => { startedFrom.current = item.body ?? ""; setEditing(true); }}>{item.body ? "Edit" : "Add notes"}</button>}</h3>
      {editing ? <>
        <textarea ref={ref} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={finish} onKeyDown={(e) => { if (e.key === "Escape") { setDraft(item.body ?? ""); setEditing(false); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur(); }} placeholder="Context, decisions, next steps, commands. Markdown works." className="w-full resize-none rounded-xl border border-line bg-transparent p-3 text-[13.5px] leading-[21px] outline-none focus:border-line-strong" />
        {changedMeanwhile && <p role="status" className="mt-1 px-1 text-[12px] text-attention">{actorName(item.updatedBy)} changed these notes while you were editing. Saving keeps your version.</p>}
      </> : item.body ? <div className="md projects-body cursor-text rounded-xl px-1 text-[13.5px] leading-[21px]" onDoubleClick={() => { startedFrom.current = item.body ?? ""; setEditing(true); }}>
        <RichMarkdown bots={Object.values(bots).map((b) => ({ slug: b.slug, name: b.name }))} components={{ a: BoardMarkdownLink }}>{item.body}</RichMarkdown>
      </div> : null}
    </section>
  );
}

function BoardMarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const id = href ? new URLSearchParams(href.split("?")[1] ?? "").get("item") : null;
  if (id && href && /^(\/?\?|https?:)/.test(href) && (href.startsWith("?") || href.startsWith("/?") || href.startsWith(location.origin))) return <button className="md-link" onClick={() => openProjects(id)}>{children}</button>;
  if (!href || !/^(https?:|mailto:)/i.test(href)) return <>{children}</>;
  return <a className="md-link" href={href} target="_blank" rel="noreferrer">{children}</a>;
}

// ---------- links ----------

function Links({ item, itemsById }: { item: BoardItem; itemsById: Record<string, BoardItem> }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const add = async () => {
    const link = parseLinkInput(value.trim());
    if (!link) { setError("Paste a web address, a T3 thread link or a Projects item link."); return; }
    try {
      await saveItems([{ id: item.id, addLinks: [link] }]);
      setValue(""); setError(""); setAdding(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't add the link"); }
  };
  if (!item.links.length && !adding) return <button className="mt-6 flex h-8 items-center gap-1.5 px-1 text-[12.5px] text-muted hover:text-fg" onClick={() => setAdding(true)}><Link2 size={13} />Add a link</button>;
  return (
    <section className="mt-6" aria-label="Links">
      <h3 className="mb-1 flex items-center px-1 text-[12.5px] font-semibold text-muted">Links{!adding && <button className="ml-auto text-[12px] font-normal hover:text-fg" onClick={() => setAdding(true)}>Add</button>}</h3>
      <ul>{item.links.map((link, index) => <LinkRow key={index} link={link} itemsById={itemsById} onRemove={() => void save({ id: item.id, removeLinks: [link] })} />)}</ul>
      {adding && <form className="mt-1 px-1" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input autoFocus value={value} onChange={(e) => { setValue(e.target.value); setError(""); }} onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }} placeholder="https://…, t3-thread://… or an item link" aria-label="Link" className="h-9 w-full rounded-xl border border-line bg-transparent px-3 text-[13.5px] outline-none focus:border-line-strong" />
        {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      </form>}
    </section>
  );
}

export function parseLinkInput(value: string): BoardLink | null {
  if (!value) return null;
  const thread = parseThreadLink(value);
  if (thread) return { type: "thread", threadId: thread.threadId, ...(thread.environmentId ? { environmentId: thread.environmentId } : {}) };
  try {
    const url = new URL(value, location.origin);
    const id = url.searchParams.get("item");
    if (id && url.origin === location.origin && /^[a-z0-9]{4,24}$/.test(id)) return { type: "item", id };
    if (/^https?:$/.test(url.protocol) && /^https?:\/\//i.test(value)) return { type: "url", url: url.href };
  } catch {}
  return null;
}

function LinkRow({ link, itemsById, onRemove }: { link: BoardLink; itemsById: Record<string, BoardItem>; onRemove: () => void }) {
  const bots = useApp((s) => s.bots);
  const threads = useApp((s) => s.threads);
  const projects = useApp((s) => s.projects);
  let icon: ReactNode = <Link2 size={14} className="text-muted" />;
  let label = link.label ?? "";
  let detail = "";
  let action: (() => void) | null = null;
  let href: string | null = null;
  if (link.type === "thread") {
    const thread = link.environmentId ? undefined : threads[link.threadId];
    const owner = thread ? Object.values(bots).find((bot) => bot.projectId === thread.projectId) : undefined;
    const bot = Object.values(bots).find((b) => b.mainThreadId === link.threadId);
    const state = threadState(thread);
    icon = bot || owner ? <Avatar shape={(bot ?? owner)!.shape} color={(bot ?? owner)!.color} picture={(bot ?? owner)!.avatarImage} size={18} state={state === "running" ? "working" : state === "waiting" ? "waiting" : "idle"} /> : <MessageSquare size={14} className="text-muted" />;
    label ||= bot ? `${bot.name}'s chat` : thread?.title || "T3 thread";
    detail = link.environmentId ? "On another machine" : state === "running" ? "Working now" : state === "waiting" ? "Needs you" : thread ? (projects[thread.projectId]?.title ?? "") : "Thread";
    if (bot) action = () => select(bot.slug);
    else if (owner && thread) action = () => selectThread(owner, thread.id);
    else if (link.environmentId) href = `/api/thread-link?environmentId=${encodeURIComponent(link.environmentId)}&threadId=${encodeURIComponent(link.threadId)}`;
  } else if (link.type === "bot") {
    const bot = bots[link.slug];
    icon = bot ? <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={18} /> : <BotIcon size={14} className="text-muted" />;
    label ||= bot?.name ?? link.slug;
    detail = "Bot";
    if (bot) action = () => select(bot.slug);
  } else if (link.type === "item") {
    const target = itemsById[link.id];
    const Icon = target ? KIND_ICON[target.kind] : Link2;
    icon = <Icon size={14} className="text-muted" />;
    label ||= target?.title ?? "Removed item";
    detail = target ? KIND_LABEL[target.kind] : "";
    if (target) action = () => openProjects(target.id);
  } else if (link.type === "url") {
    let host = "";
    try { host = new URL(link.url).host; } catch {}
    label ||= host || link.url;
    detail = link.label ? host : "";
    href = link.url;
  } else {
    label ||= projects[link.projectId]?.title ?? "T3 project";
    detail = link.environmentId ? "T3 project on another machine" : "T3 project";
    icon = <FolderGit2 size={14} className="text-muted" />;
  }
  const content = <><span className="grid size-5 shrink-0 place-items-center">{icon}</span><span className="min-w-0 flex-1 truncate text-[13.5px]">{label}</span>{detail && <span className="max-w-[45%] shrink-0 truncate text-[12px] text-muted">{detail}</span>}</>;
  return (
    <li className="projects-row group">
      {action ? <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={action}>{content}</button>
        : href ? <a className="flex min-w-0 flex-1 items-center gap-2.5" href={href} target="_blank" rel="noreferrer">{content}</a>
        : <span className="flex min-w-0 flex-1 items-center gap-2.5">{content}</span>}
      <button className="projects-remove grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg" aria-label={`Remove link ${label}`} onClick={onRemove}><X size={12} /></button>
    </li>
  );
}

// ---------- item links in chat ----------

/** A Projects item link in a chat message: the item's title, opening it in the app. */
export function BoardItemChip({ id, children }: { id: string; children?: ReactNode }) {
  useEffect(() => ensureBoard(), []);
  const item = useBoard((s) => s.items[id]);
  const Icon = item ? KIND_ICON[item.kind] : FolderKanban;
  return (
    <button className="projects-chat-chip" onClick={() => openProjects(id)} title="Open in Projects">
      <Icon size={13} aria-hidden="true" />
      <span>{item?.title ?? children}</span>
      {item?.kind === "task" && item.status === "done" && <Check size={12} aria-label="done" />}
    </button>
  );
}
