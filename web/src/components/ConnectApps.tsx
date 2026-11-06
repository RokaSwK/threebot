import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Plug, Search, X } from "lucide-react";
import { Modal, Pill, Spinner } from "./ui";
import { SkillsDialog } from "./SkillsDialog";
import { watchProviderData } from "../lib/providerData";
import { parseSkills, type ProviderSkill } from "../lib/skillsApi";
import { openDialog, useApp } from "../store";
import { AppIcon } from "./AppIcon";
import { executorApi, executorConnectionConfirmed as confirmed, type CatalogEntry, type ExecutorAccount, type ExecutorApp, type ExecutorConnection, type ExecutorRequirement, type ExecutorStatus } from "../lib/executor";

type View = { kind: "catalog"; entry: CatalogEntry } | { kind: "list" } | { kind: "app"; app: ExecutorApp } | { kind: "connection"; connection: ExecutorConnection; app: ExecutorApp | null; reconnect?: ExecutorAccount };
const statusLabel = (app: ExecutorApp) => ({ ready: "Ready", connected: "Connected", "needs-connection": "Needs sign-in", unknown: "Status unavailable" })[app.status];
const ACRONYMS = new Set(["ai", "api", "crm", "erp", "hr", "it", "seo", "sql"]);
/** Executor's categories are lowercase slugs; the catalog displays them as titles. */
const categoryLabel = (name: string) => name.replace(/\p{L}+/gu, (word) => ACRONYMS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));

const message = (error: unknown) => error instanceof Error ? error.message : "Couldn't complete the apps request. Try again.";
const CATALOG_PAGE_SIZE = 30;

export function ConnectApps({ onClose = () => openDialog(null), onBack, initialUrl }: { onClose?: () => void; onBack?: () => void; initialUrl?: string } = {}) {
  const bot = useApp((s) => s.selected ? s.bots[s.selected] : null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  useEffect(() => watchProviderData((value) => { try { setSkills(parseSkills(value, bot?.workspaceRoot ?? null)); } catch { setSkills([]); } }, () => setSkills([]), bot?.mainThreadId ?? null), [bot?.workspaceRoot, bot?.mainThreadId]);
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [statusPending, setStatusPending] = useState(true);
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  const matchingSkills = skills.filter((skill) => [skill.title, skill.name, skill.description].some((value) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const [category, setCategory] = useState("");
  const [shelf, setShelf] = useState(false);
  const catalogScroll = useRef<HTMLDivElement>(null);
  const homeScroll = useRef(0);
  const detailScroll = useRef(0);
  const restoreScroll = useRef<number | null>(null);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CATALOG_PAGE_SIZE);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true), generation = useRef(0), operation = useRef<symbol | null>(null), statusRevision = useRef(0), readRevision = useRef(0), appRevision = useRef(0);
  const appUpdates = useRef(new Map<string, ExecutorApp>());
  const viewRef = useRef(view); viewRef.current = view;

  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const navigate = (next: View) => { generation.current++; readRevision.current++; operation.current = null; setBusy(null); setError(""); setView(next); };
  const refresh = async () => {
    const revision = ++statusRevision.current;
    const appsAtStart = appRevision.current;
    setStatusPending(true);
    try {
      const next = await executorApi.status();
      if (alive.current && statusRevision.current === revision) {
        setStatusError("");
        if (appsAtStart !== appRevision.current) {
          const merged = new Map(next.connections.map((app) => [app.id, app]));
          for (const app of appUpdates.current.values()) merged.set(app.id, app);
          setStatus({ ...next, connections: [...merged.values()] });
        } else { appUpdates.current.clear(); setStatus(next); }
      }
    }
    catch (failure) { if (alive.current && statusRevision.current === revision) setStatusError(message(failure)); }
    finally { if (alive.current && statusRevision.current === revision) setStatusPending(false); }
  };
  const publishApp = (app: ExecutorApp) => { appRevision.current++; appUpdates.current.set(app.id, app); setStatus((previous) => previous ? { ...previous, connections: previous.connections.some((entry) => entry.id === app.id) ? previous.connections.map((entry) => entry.id === app.id ? app : entry) : [...previous.connections, app] } : previous); };
  async function perform<T>(label: string, task: () => Promise<T>, accept: (value: T) => void, reject?: () => void) {
    if (operation.current) return;
    const key = Symbol(), revision = generation.current;
    readRevision.current++;
    operation.current = key; setBusy(label); setError("");
    try { const value = await task(); if (alive.current && revision === generation.current) accept(value); else reject?.(); }
    catch (failure) { reject?.(); if (alive.current && revision === generation.current) setError(message(failure)); }
    finally { if (operation.current === key) { operation.current = null; if (alive.current) setBusy(null); } }
  }
  const showApp = (app: ExecutorApp) => {
    if (viewRef.current.kind === "list") detailScroll.current = catalogScroll.current?.scrollTop ?? 0;
    navigate({ kind: "app", app });
    void perform("refresh", () => executorApi.app(app.id), (next) => { publishApp(next); setView({ kind: "app", app: next }); });
  };
  const loadLink = () => {
    if (!initialUrl) return;
    void perform("resolve", () => executorApi.resolve(initialUrl), (result) => {
      if (result.kind === "app") { publishApp(result.app); setView({ kind: "app", app: result.app }); }
      else if (result.kind === "connection") {
        setView({ kind: "connection", connection: result.connection, app: null });
        const read = readRevision.current;
        void executorApi.app(result.connection.appId).then((app) => {
          if (!alive.current || readRevision.current !== read) return;
          publishApp(app);
          setView((current) => current.kind === "connection" && current.connection.id === result.connection.id ? { ...current, app } : current);
        }).catch(() => {});
      } else setView({ kind: "list" });
    });
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { navigate({ kind: "list" }); loadLink(); }, [initialUrl]);

  useEffect(() => {
    if (!status?.hasToken) return;
    const controller = new AbortController();
    setCatalog(null); setCatalogError("");
    executorApi.catalog("", controller.signal).then((entries) => { if (!controller.signal.aborted) setCatalog(entries); }).catch((failure) => { if (!controller.signal.aborted) setCatalogError(message(failure)); });
    return () => controller.abort();
  }, [status?.hasToken, catalogAttempt]);
  const categories = useMemo(() => [...new Set((catalog ?? []).flatMap((entry) => entry.category ? [entry.category] : []))].sort((a, b) => a.localeCompare(b)), [catalog]);
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (catalog ?? []).filter((entry) => (!category || category === "__all" || entry.category === category) && (!search || [entry.name, entry.id, entry.description, entry.category ?? ""].some((value) => value.toLocaleLowerCase().includes(search))));
  }, [catalog, query, category]);
  useEffect(() => setVisibleCount(CATALOG_PAGE_SIZE), [catalog, query, category]);

  const checkConnection = (current: Extract<View, { kind: "connection" }>) => perform("check", async () => {
    const connection = await executorApi.connection(current.connection);
    const app = await executorApi.app(connection.appId);
    return { connection, app };
  }, ({ connection, app }) => { publishApp(app); setView({ ...current, connection, app }); });
  useEffect(() => {
    const check = () => {
      if (operation.current) return;
      const current = viewRef.current;
      if (current.kind === "connection" && (current.connection.status === "pending" || current.connection.status === "completed")) void checkConnection(current);
      else if (current.kind === "app") void perform("refresh", () => executorApi.app(current.app.id), (app) => { publishApp(app); setView({ kind: "app", app }); });
      else if (current.kind === "list") void refresh();
    };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, []);

  const connect = (app: ExecutorApp, requirement: ExecutorRequirement, account?: ExecutorAccount) => {
    if (operation.current) return;
    // Create only the direct sign-in popup in this user gesture, never a dashboard.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    void perform("connect", () => executorApi.connect(app.id, requirement, account), (connection) => {
      setView({ kind: "connection", connection, app, ...(account ? { reconnect: account } : {}) });
      if (connection.status === "pending") { if (popup) popup.location.href = connection.url; }
      else popup?.close();
    }, () => popup?.close());
  };
  const back = () => {
    if (view.kind === "connection" && view.app) navigate({ kind: "app", app: view.app });
    else if (view.kind !== "list") { restoreScroll.current = detailScroll.current; navigate({ kind: "list" }); }
    else if (shelf) { restoreScroll.current = homeScroll.current; setShelf(false); setCategory(""); setConnectedOnly(false); setInstalledOnly(false); }
    else onBack?.();
  };
  useLayoutEffect(() => {
    if (view.kind === "list" && catalogScroll.current && restoreScroll.current !== null) { catalogScroll.current.scrollTop = restoreScroll.current; restoreScroll.current = null; }
  }, [view.kind, category, shelf]);
  const openShelf = (name: string) => { homeScroll.current = catalogScroll.current?.scrollTop ?? 0; restoreScroll.current = 0; setCategory(name); setShelf(true); };
  const retryList = () => { void refresh(); setCatalogAttempt((attempt) => attempt + 1); };
  const retry = () => {
    if (view.kind === "app") showApp(view.app);
    else if (view.kind === "connection") void checkConnection(view);
    else if (initialUrl) loadLink();
    else retryList();
  };
  const installed = (status?.connections ?? []).filter((app) => !query || app.name.toLowerCase().includes(query.toLowerCase()));
  const incompleteStatus = !!status?.error || !!status?.connections.some((app) => app.status === "unknown" || app.error);
  const connectedCount = !status?.hasToken || statusPending || statusError || incompleteStatus ? null : status.connections.filter((app) => app.status === "connected").length;
  const installedFor = (entry: CatalogEntry) => status?.connections.find((app) => app.id === entry.id || app.slug === entry.id) ?? ((catalog ?? []).filter((item) => item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()).length === 1 ? status?.connections.find((app) => app.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()) : undefined);
  const entryFor = (app: ExecutorApp) => catalog?.find((entry) => entry.id === app.id || entry.id === app.slug || entry.name.toLocaleLowerCase() === app.name.toLocaleLowerCase());
  const addApp = (entry: CatalogEntry) => void perform(`install:${entry.id}`, () => executorApi.install(entry), (app) => { publishApp(app); setView({ kind: "app", app }); });
  const catalogRow = (entry: CatalogEntry) => {
    const app = installedFor(entry);
    const connected = app?.status === "connected";
    return <div className="apps-row" key={entry.id}>
      <button className="apps-row-main" onClick={() => app ? showApp(app) : (() => { detailScroll.current = catalogScroll.current?.scrollTop ?? 0; navigate({ kind: "catalog", entry }); })()} aria-label={`Open ${entry.name}`}>
        <AppIcon name={entry.name} src={entry.icon} /><span className="apps-row-copy"><span>{entry.name}</span><small>{entry.description || entry.category || "App integration"}</small></span>
      </button>
      <Pill variant="soft" disabled={connected || busy !== null} onClick={() => app ? showApp(app) : addApp(entry)} aria-label={`${connected ? "Connected to" : "Connect"} ${entry.name}`}>{busy === `install:${entry.id}` ? <Spinner /> : connected ? "Connected" : "Connect"}</Pill>
    </div>;
  };
  const installedRow = (app: ExecutorApp) => {
    const entry = entryFor(app);
    return <div className="apps-row" key={app.id}><button className="apps-row-main" aria-label={`Open ${app.name}`} onClick={() => showApp(app)}><AppIcon name={app.name} src={[app.icon, entry?.icon]} domain={app.domain} /><span className="apps-row-copy"><span>{app.name}</span><small>{entry?.description || statusLabel(app)}</small></span></button><Pill variant="soft" disabled={app.status === "connected" || busy !== null} onClick={() => showApp(app)}>{app.status === "connected" ? "Connected" : "Connect"}</Pill></div>;
  };
  const section = (name: string, entries: CatalogEntry[], all: () => void) => entries.length > 0 && <section className="apps-section" key={name}><button className="apps-section-title" onClick={all}>{name}<ChevronRight size={17} /><span>View all</span></button>{entries.map(catalogRow)}</section>;
  const title = view.kind === "catalog" ? view.entry.name : view.kind === "app" ? view.app.name : view.kind === "connection" ? view.app?.name ?? "Connect account" : "Connect apps";

  return <><Modal onClose={onClose} onBack={view.kind !== "list" || shelf || onBack ? back : undefined} backIcon={shelf && view.kind === "list" ? <ChevronLeft size={20} /> : <X size={18} />} title={view.kind === "list" ? title : <span className="sr-only">{title}</span>} className={`connect-apps-sheet h-[min(780px,90vh)] w-[min(640px,96vw)] ${view.kind === "list" ? "" : "connect-app-detail"}`} headerActions={view.kind === "list" ? <Pill variant="soft" className="connected-count" disabled={connectedCount === null} onClick={() => { homeScroll.current = catalogScroll.current?.scrollTop ?? 0; restoreScroll.current = 0; setShelf(true); setInstalledOnly(false); setConnectedOnly(true); }} aria-pressed={connectedOnly}>{statusPending ? <Spinner /> : connectedCount === null ? "Status unavailable" : `${connectedCount} connected`}</Pill> : undefined}>
    {statusError && <div role="alert" className="m-4 flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-[13px] text-danger"><span className="min-w-0 flex-1 break-words">Couldn't load apps: {statusError}</span><Pill variant="soft" onClick={retryList} disabled={statusPending}>Retry</Pill></div>}
    {error && <div role="alert" className="m-4 flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-[13px] text-danger"><span className="min-w-0 flex-1 break-words">{error}</span><Pill variant="soft" onClick={retry} disabled={busy !== null}>Retry</Pill></div>}
    {!status && !statusError && <div className="grid flex-1 place-items-center py-16 text-muted"><Spinner size={18} /></div>}
    {status && (!status.configured || !status.hasToken) && <div className="dialog-body mx-auto max-w-[420px] px-5 py-12 text-center"><span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-card text-muted"><Plug size={20} /></span><div className="text-[15px] font-medium">Apps aren't set up yet</div><p className="mt-2 text-[13px] text-muted">The app's Executor connection needs to be configured before accounts can be managed here.</p></div>}
    {status?.hasToken && view.kind === "list" && <>
      <div hidden={!!query.trim()} className="apps-filters" role="tablist" aria-label="App categories">
        {["", ...categories].map((name) => <button key={name} role="tab" aria-selected={!connectedOnly && category === name} onClick={() => { setCategory(name); setConnectedOnly(false); setInstalledOnly(false); setShelf(false); restoreScroll.current = 0; }}>{name ? categoryLabel(name) : "All"}</button>)}
      </div>
      <div ref={catalogScroll} className="apps-catalog scroll-thin">
        {incompleteStatus && <div role="status" className="apps-notice">Some connection details couldn't be checked. Refresh before using them. <Pill variant="soft" onClick={retryList} disabled={statusPending}>Retry</Pill></div>}
        {catalogError && <div role="alert" className="apps-notice">Couldn't search apps: {catalogError} <Pill variant="soft" onClick={retryList} disabled={statusPending}>Retry search</Pill></div>}
        {!catalog && !catalogError && <div className="grid place-items-center py-8 text-muted"><Spinner /></div>}
        {connectedOnly || installedOnly ? <section className="apps-section"><h2 className="apps-section-title">Installed</h2>{installed.filter((app) => installedOnly || app.status === "connected").map(installedRow)}{connectedCount !== null && !installed.some((app) => installedOnly || app.status === "connected") && <p className="apps-notice">No connected apps{query ? " match your search" : " yet"}.</p>}</section>
        : query.trim() || category ? <section className="apps-section"><h2 className="apps-section-title">{category === "__all" ? "All apps" : category ? categoryLabel(category) : "Results"}{catalog && !catalogError && <span role="status">{matches.length} apps</span>}</h2>{matches.slice(0, visibleCount).map(catalogRow)}{catalog && !catalogError && !matches.length && !matchingSkills.length && <p className="apps-notice apps-empty"><Search size={22} aria-hidden="true" /><span>No results match "{query.trim()}".</span></p>}{visibleCount < matches.length && <Pill variant="soft" onClick={() => setVisibleCount((count) => count + CATALOG_PAGE_SIZE)}>Load more apps</Pill>}</section>
        : <>
          {catalog?.length === 0 && <p className="apps-notice">No apps are available right now.</p>}
          {installed.length > 0 && <section className="apps-section"><button className="apps-section-title" onClick={() => { homeScroll.current = catalogScroll.current?.scrollTop ?? 0; restoreScroll.current = 0; setShelf(true); setConnectedOnly(false); setInstalledOnly(true); }}>Your apps<ChevronRight size={17} /><span>View all</span></button>{installed.slice(0, 4).map(installedRow)}</section>}
          {section("Browse apps", (catalog ?? []).slice(0, 4), () => openShelf("__all"))}
          {categories.map((name) => section(categoryLabel(name), (catalog ?? []).filter((entry) => entry.category === name).slice(0, 3), () => openShelf(name)))}
        </>}
        {query.trim() && matchingSkills.length > 0 && <section className="apps-section"><button className="apps-section-title" onClick={() => setSkillsOpen(true)}>Skills<ChevronRight size={17} /><span>{matchingSkills.length} matches</span></button>{matchingSkills.slice(0, 3).map((skill) => <button key={skill.key} className="apps-row-main" onClick={() => setSkillsOpen(true)}><Plug size={24} /><span className="apps-row-copy"><span>{skill.title}</span><small>{skill.provider} · {skill.description}</small></span></button>)}</section>}
      </div>
      <div className="apps-search"><Search size={18} /><input aria-label="Search apps" autoComplete="off" autoCorrect="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={connectedOnly || installedOnly ? "Search plugins" : "Search across apps and skills"} />{query && <button onClick={() => setQuery("")} aria-label="Clear app search">×</button>}</div>
    </>}
    {status?.hasToken && view.kind === "catalog" && <div className="apps-detail"><AppIcon name={view.entry.name} src={view.entry.icon} /><h2>{view.entry.name}</h2><p>{view.entry.description}</p><div className="apps-detail-action"><Pill disabled={busy !== null} onClick={() => addApp(view.entry)}>{busy ? <Spinner /> : "Connect"}</Pill></div></div>}
    {status?.hasToken && view.kind === "app" && <div className="apps-detail apps-account-detail dialog-body scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4"><AppIcon name={view.app.name} src={[view.app.icon, entryFor(view.app)?.icon]} domain={view.app.domain} /><h2>{view.app.name}</h2><p className="apps-detail-description">{entryFor(view.app)?.description}</p><h3>Accounts</h3><p className="mb-4 text-[13px] text-muted">{statusLabel(view.app)}</p>{view.app.error && <p role="status" className="mb-4 text-[13px] text-attention">Some account details couldn't be checked.</p>}{view.app.status === "ready" && !view.app.requirements.length && <p className="text-[14px]">This app doesn't require an account.</p>}{view.app.requirements.map((requirement) => <fieldset key={`${requirement.scope}:${requirement.id}`} disabled={busy !== null} className="mb-4 min-w-0 rounded-xl border border-line p-3"><legend className="max-w-full break-words px-1 text-[14px] font-medium">{requirement.name}</legend><p className="mb-3 text-[12px] text-muted">{requirement.scope === "user" ? "Linked for you" : "Linked for everyone"} · {requirement.cardinality === "many" ? "Choose any accounts" : "Choose one account"}</p>{requirement.accounts.length === 0 && <p className="mb-3 text-[13px] text-muted">No accounts connected yet.</p>}{requirement.accounts.map((account) => <div key={account.id} className="mb-3 flex flex-wrap items-center gap-2"><label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-[14px]"><input type={requirement.cardinality === "one" ? "radio" : "checkbox"} name={`${requirement.scope}:${requirement.id}`} checked={account.linked} onChange={() => void perform("link", () => executorApi.link(view.app.id, requirement, account, requirement.cardinality === "one" || !account.linked), (app) => { publishApp(app); setView({ kind: "app", app }); })} /><span className="min-w-0 break-words">{account.name}{account.linked && account.signIn === "saved" && <span className="ml-2 text-[12px] text-success">Connected</span>}{account.signIn !== "saved" && <span className="ml-2 text-[12px] text-muted">Needs sign-in</span>}</span></label>{requirement.cardinality === "one" && account.linked && <Pill variant="soft" onClick={() => void perform("link", () => executorApi.link(view.app.id, requirement, account, false), (app) => { publishApp(app); setView({ kind: "app", app }); })}>Unlink</Pill>}{account.signIn !== "saved" && <Pill variant="soft" onClick={() => connect(view.app, requirement, account)}>Reconnect</Pill>}</div>)}<Pill onClick={() => connect(view.app, requirement)}>Connect new account</Pill></fieldset>)}</div>}
    {status?.hasToken && view.kind === "connection" && <div className="dialog-body scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-6">
      {confirmed(view.connection, view.app) ? <div role="status" className="flex items-center gap-2 text-[15px]"><Check size={18} className="text-success" />Account connected</div> : <>
        <h2 className="text-[16px] font-medium">{view.connection.status === "pending" ? "Finish connecting your account" : view.connection.status === "completed" ? "Checking the account link" : view.connection.status === "expired" ? "This sign-in request expired" : "This sign-in request was cancelled"}</h2>
        <p className="mt-2 text-[13px] leading-5 text-muted">{view.connection.status === "pending" ? "Continue sign-in, then return here to check the account. Closing the sign-in window doesn't confirm a connection." : view.connection.status === "completed" ? "Sign-in finished, but a usable linked account hasn't been confirmed yet." : "Start a new sign-in request when you're ready."}</p>
        {view.connection.error && <p role="status" className="mt-3 text-[13px] text-attention">Sign-in needs attention. Continue sign-in or check again.</p>}
        <div className="mt-5 flex flex-wrap gap-2">{view.connection.status === "pending" && <Pill onClick={() => window.open(view.connection.url, "_blank", "noopener,noreferrer")}>Continue sign-in <ExternalLink size={12} /></Pill>}<Pill variant="soft" onClick={() => void checkConnection(view)} disabled={busy !== null}>{busy === "check" && <Spinner />}Check again</Pill>{(view.connection.status === "expired" || view.connection.status === "cancelled") && view.app && <Pill disabled={busy !== null} onClick={() => { const requirement = view.app?.requirements.find((item) => item.id === view.connection.requirement && item.scope === view.connection.scope); if (view.app && requirement) connect(view.app, requirement, view.reconnect); }}>Start again</Pill>}</div>
      </>}
      {view.app && <Pill variant="soft" className="mt-5" onClick={() => { if (view.app) showApp(view.app); }}>Manage accounts</Pill>}
    </div>}
  </Modal>{skillsOpen && <SkillsDialog initialQuery={query} onClose={() => setSkillsOpen(false)} />}</>;
}
