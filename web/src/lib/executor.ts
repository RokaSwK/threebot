export type ExecutorBackend = "cloud" | "self-hosted";
export type ExecutorAccount = { id: string; name: string; linked: boolean; signIn: "saved" | "reconnect" | "unavailable" };
export type ExecutorRequirement = { id: string; scope: "user" | "app"; name: string; cardinality: "one" | "many"; accounts: ExecutorAccount[] };
export type ExecutorApp = { id: string; slug: string; name: string; status: "ready" | "connected" | "needs-connection" | "unknown"; requirements: ExecutorRequirement[]; error?: string };
export type ExecutorConnection = { id: string; backend: ExecutorBackend; appId: string; requirement: string; scope: "user" | "app"; url: string; status: "pending" | "completed" | "expired" | "cancelled"; expiresAt: string; error?: string };
export type ExecutorStatus = { configured: boolean; hasToken: boolean; backend: ExecutorBackend; backupAvailable: boolean; connections: ExecutorApp[]; error?: string };
export type CatalogEntry = { id: string; name: string; description: string; icon: string | null; auth: string[]; authLabels: string[]; category: string | null };
export type ExecutorLink = { kind: "connection"; connection: ExecutorConnection } | { kind: "app"; app: ExecutorApp } | { kind: "apps" };

export function executorConnectionConfirmed(connection: ExecutorConnection, app: ExecutorApp | null) {
  return connection.status === "completed" && !!app?.requirements.find((requirement) => requirement.id === connection.requirement && requirement.scope === connection.scope)?.accounts.some((account) => account.linked && account.signIn === "saved");
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = () => new Error("The apps service returned an invalid response. Try again.");
function string(value: unknown): string { if (typeof value !== "string") throw invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function oneOf<const T extends string>(value: unknown, options: readonly T[]): T { for (const option of options) if (value === option) return option; throw invalid(); }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(value)) throw invalid(); return value.map(parse); }
function object(value: unknown): Record<string, unknown> { if (!record(value)) throw invalid(); return value; }

function account(value: unknown): ExecutorAccount {
  const v = object(value);
  return { id: string(v.id), name: string(v.name), linked: bool(v.linked), signIn: oneOf(v.signIn, ["saved", "reconnect", "unavailable"]) };
}
function requirement(value: unknown): ExecutorRequirement {
  const v = object(value);
  return { id: string(v.id), scope: oneOf(v.scope, ["user", "app"]), name: string(v.name), cardinality: oneOf(v.cardinality, ["one", "many"]), accounts: array(v.accounts, account) };
}
export function parseExecutorApp(value: unknown): ExecutorApp {
  const v = object(value);
  return { id: string(v.id), slug: string(v.slug), name: string(v.name), status: oneOf(v.status, ["ready", "connected", "needs-connection", "unknown"]), requirements: array(v.requirements, requirement), ...(typeof v.error === "string" ? { error: v.error } : {}) };
}
export function parseExecutorConnection(value: unknown): ExecutorConnection {
  const v = object(value), url = string(v.url);
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw invalid();
  return { id: string(v.id), backend: oneOf(v.backend, ["cloud", "self-hosted"]), appId: string(v.appId), requirement: string(v.requirement), scope: oneOf(v.scope, ["user", "app"]), url, status: oneOf(v.status, ["pending", "completed", "expired", "cancelled"]), expiresAt: string(v.expiresAt), ...(typeof v.error === "string" ? { error: v.error } : {}) };
}
function status(value: unknown): ExecutorStatus {
  const v = object(value);
  const configured = bool(v.configured), hasToken = v.hasToken === undefined ? false : bool(v.hasToken);
  if (!configured && hasToken) throw invalid();
  return { configured, hasToken, backend: v.backend === undefined ? "self-hosted" : oneOf(v.backend, ["cloud", "self-hosted"]), backupAvailable: v.backupAvailable === undefined ? false : bool(v.backupAvailable), connections: v.connections === undefined ? [] : array(v.connections, parseExecutorApp), ...(typeof v.error === "string" ? { error: v.error } : {}) };
}
function catalog(value: unknown) {
  return array(object(value).entries, (item): CatalogEntry => {
    const v = object(item);
    return { id: string(v.id), name: string(v.name), description: string(v.description), icon: v.icon === null ? null : string(v.icon), auth: array(v.auth, string),
      category: v.category === undefined || v.category === null ? null : string(v.category), authLabels: v.authLabels === undefined ? [] : array(v.authLabels, string) };
  });
}
function link(value: unknown): ExecutorLink {
  const v = object(value);
  switch (v.kind) {
    case "apps": return { kind: "apps" };
    case "app": return { kind: "app", app: parseExecutorApp(v.app) };
    case "connection": return { kind: "connection", connection: parseExecutorConnection(v.connection) };
    default: throw invalid();
  }
}

async function request<T>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, init); }
  catch (error) { if (init?.signal?.aborted) throw error; throw new Error("Couldn't reach the apps service. Try again."); }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in to the app again to manage connections.");
    if (response.status === 403) throw new Error("You don't have permission to change this connection.");
    if (response.status === 409) throw new Error("The connection changed or belongs to another Executor backend. Refresh and try again.");
    throw new Error("Couldn't complete the apps request. Try again.");
  }
  try { const value: unknown = await response.json(); return parse(value); }
  catch { throw invalid(); }
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const appResponse = (value: unknown) => parseExecutorApp(object(value).app);
const appResponseFor = (id: string) => (value: unknown) => { const app = appResponse(value); if (app.id !== id) throw invalid(); return app; };
const appPath = (id: string) => `/api/executor/apps/${encodeURIComponent(id)}`;
export const executorApi = {
  status: (signal?: AbortSignal) => request("/api/executor", status, { signal }),
  catalog: (query: string, signal?: AbortSignal) => request(`/api/executor/catalog?search=${encodeURIComponent(query)}`, catalog, { signal }),
  install: (entry: CatalogEntry) => request("/api/executor/install", appResponse, post({ entry: entry.id, name: entry.name })),
  app: (id: string, signal?: AbortSignal) => request(appPath(id), appResponseFor(id), { signal }),
  link: (id: string, requirement: ExecutorRequirement, account: ExecutorAccount, linked: boolean) => request(`${appPath(id)}/accounts`, appResponseFor(id), post({ requirement: requirement.id, scope: requirement.scope, account: account.id, linked })),
  connect: (id: string, requirement: ExecutorRequirement, account?: ExecutorAccount) => request(`${appPath(id)}/connections`, (raw) => {
    const connection = parseExecutorConnection(raw);
    if (connection.appId !== id || connection.requirement !== requirement.id || connection.scope !== requirement.scope) throw invalid();
    return connection;
  }, post({ requirement: requirement.id, scope: requirement.scope, ...(account ? { account: account.id } : {}) })),
  connection: (value: ExecutorConnection) => request(`/api/executor/connections/${encodeURIComponent(value.id)}?backend=${encodeURIComponent(value.backend)}`, (raw) => {
    const next = parseExecutorConnection(raw);
    if (next.id !== value.id || next.backend !== value.backend || next.appId !== value.appId || next.requirement !== value.requirement || next.scope !== value.scope) throw invalid();
    return next;
  }),
  resolve: (url: string, signal?: AbortSignal) => request("/api/executor/resolve-link", link, { ...post({ url }), signal }),
};

export function isExecutorUrl(href: string, configured: string | null): boolean {
  if (!configured) return false;
  try {
    const url = new URL(href), base = new URL(configured);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.origin !== base.origin) return false;
    const pieces = url.pathname.split("/").filter(Boolean);
    return url.pathname === "/" || pieces.includes("apps") || [...pieces, ...url.searchParams.values()].some((value) => /^con_[A-Za-z0-9_-]+$/.test(value));
  } catch { return false; }
}
