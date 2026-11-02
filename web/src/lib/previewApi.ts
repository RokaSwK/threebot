import { environmentPrefix, threadClient, threadTarget, type StreamHandle, type T3Client } from "./t3";

// The v0.1.5 preview UI contract is distinct from the agent-only automation API.
export type BrowserTab = {
  threadId: string;
  tabId: string;
  runtime: "server" | "desktop" | "unknown";
  profileId: string | null;
  url: string;
  title: string;
  status: "Idle" | "Loading" | "Success" | "LoadFailed";
  error: string | null;
  download: { id: string; fileName: string } | null;
};
export type BrowserIndex = { serverEpoch: string; revision: number; tabs: BrowserTab[] };
export type BrowserState =
  | { kind: "loading" }
  | { kind: "ready"; index: BrowserIndex }
  | { kind: "error"; message: string; index: BrowserIndex | null };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser response");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid browser text field");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid browser revision");
  return value;
}
export function parseBrowserTab(value: unknown): BrowserTab {
  const tab = record(value), nav = record(tab.navStatus);
  const status = nav._tag;
  if (status !== "Idle" && status !== "Loading" && status !== "Success" && status !== "LoadFailed") throw new Error("Unsupported browser status");
  const download = nav.download == null ? null : record(nav.download);
  return {
    threadId: string(tab.threadId), tabId: string(tab.tabId),
    runtime: tab.runtime === "server" || tab.runtime === "desktop" ? tab.runtime : "unknown",
    profileId: typeof tab.profileId === "string" ? tab.profileId : null,
    status, url: status === "Idle" ? "" : string(nav.url), title: status === "Idle" ? "" : string(nav.title),
    error: status === "LoadFailed" ? string(nav.description) : null,
    download: download ? { id: string(download.id), fileName: string(download.fileName) } : null,
  };
}
export function parseBrowserIndex(value: unknown): BrowserIndex {
  const result = record(value);
  if (!Array.isArray(result.sessions)) throw new Error("Browser sessions are unavailable");
  return { serverEpoch: string(result.serverEpoch), revision: revision(result.revision), tabs: result.sessions.map(parseBrowserTab) };
}
type BrowserEvent = { serverEpoch: string; revision: number; threadId: string; tabId: string } & (
  | { type: "upsert"; tab: BrowserTab }
  | { type: "closed" }
  | { type: "failed"; url: string; title: string; error: string; download: BrowserTab["download"] }
);
function parseEvent(value: unknown): BrowserEvent {
  const event = record(value);
  const base = { serverEpoch: string(event.serverEpoch), revision: revision(event.revision), threadId: string(event.threadId), tabId: string(event.tabId) };
  switch (event.type) {
    case "opened": case "navigated": case "resized": {
      const tab = parseBrowserTab(event.snapshot);
      if (tab.threadId !== base.threadId || tab.tabId !== base.tabId) throw new Error("Browser event target differs from its session");
      return { ...base, type: "upsert", tab };
    }
    case "closed": return { ...base, type: "closed" };
    case "failed": {
      const download = event.download == null ? null : record(event.download);
      return { ...base, type: "failed", url: string(event.url), title: string(event.title), error: string(event.description), download: download ? { id: string(download.id), fileName: string(download.fileName) } : null };
    }
    default: throw new Error("Unsupported browser event");
  }
}
function applyEvent(index: BrowserIndex, event: BrowserEvent): BrowserIndex {
  if (event.serverEpoch !== index.serverEpoch || event.revision <= index.revision) return index;
  let tabs = index.tabs;
  if (event.type === "closed") tabs = tabs.filter(tab => tab.tabId !== event.tabId);
  if (event.type === "upsert") tabs = tabs.some(tab => tab.tabId === event.tabId) ? tabs.map(tab => tab.tabId === event.tabId ? event.tab : tab) : [...tabs, event.tab];
  if (event.type === "failed") {
    const previous = index.tabs.find(tab => tab.tabId === event.tabId);
    if (previous) tabs = tabs.map(tab => tab.tabId === event.tabId ? { ...previous, status: "LoadFailed", url: event.url, title: event.title, error: event.error, download: event.download } : tab);
  }
  return { ...index, revision: event.revision, tabs };
}

/** Subscribe before listing, replay racing events, and reconcile again after reconnect.
 * No polling and no browser open, profile mutation, or control claim during observation.
 */
export function watchBrowser(threadKey: string, emit: (state: BrowserState) => void, client: Pick<T3Client, "call" | "stream" | "onReconnect" | "onState"> = threadClient(threadKey)) {
  const { threadId } = threadTarget(threadKey);
  let index: BrowserIndex | null = null, stopped = false, generation = 0;
  let streamFailure: Error | null = null;
  let stream: StreamHandle | undefined, loading = false, buffered: BrowserEvent[] = [];
  const fail = (error: unknown) => {
    if (!stopped) emit({ kind: "error", message: error instanceof Error ? error.message : "Browser unavailable", index });
  };
  const publish = () => {
    if (streamFailure) fail(streamFailure);
    else if (index) emit({ kind: "ready", index });
  };
  const refresh = async () => {
    if (stopped || loading) return;
    loading = true;
    const requestGeneration = generation;
    try {
      const next = parseBrowserIndex(await client.call<unknown>("preview.list", { threadId }));
      if (stopped || requestGeneration !== generation) return;
      next.tabs = next.tabs.filter(tab => tab.threadId === threadId);
      const events = buffered; buffered = [];
      // A new server event can overtake a response from the old process.
      if (events.length && events.at(-1)?.serverEpoch !== next.serverEpoch) {
        loading = false; void refresh(); return;
      }
      index = events.reduce(applyEvent, next);
      publish();
    } catch (error) { if (requestGeneration === generation) fail(error); }
    finally { if (requestGeneration === generation) loading = false; }
  };
  const start = () => {
    if (stopped) return;
    generation++; stream?.cancel(); loading = false; buffered = []; streamFailure = null;
    const streamGeneration = generation;
    stream = client.stream("subscribePreviewEvents", {}, (value: unknown) => {
      if (stopped || streamGeneration !== generation) return;
      try {
        const event = parseEvent(value);
        if (event.threadId !== threadId) return;
        if (loading || !index || event.serverEpoch !== index.serverEpoch) { buffered.push(event); void refresh(); return; }
        index = applyEvent(index, event); publish();
      } catch (error) { fail(error); }
    });
    void stream.done.catch(error => {
      if (streamGeneration !== generation) return;
      streamFailure = error instanceof Error ? error : new Error("Browser updates unavailable");
      fail(streamFailure);
    });
    void refresh();
  };
  emit({ kind: "loading" });
  const reconnect = client.onReconnect(start);
  const connection = client.onState(state => { if (state === "closed") { generation++; loading = false; fail(new Error("Connection lost. Reconnecting…")); } });
  start();
  return { refresh: async () => { if (streamFailure) start(); else await refresh(); }, dispose: () => { stopped = true; generation++; stream?.cancel(); reconnect(); connection(); } };
}

export function browserStreamUrl(threadKey: string, tabId: string, interactive: boolean) {
  const target = threadTarget(threadKey);
  const query = new URLSearchParams({ threadId: target.threadId, tabId, maxWidth: "1600", maxHeight: "1000", quality: "70", interactive: String(interactive) });
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${environmentPrefix(target.environmentId)}/api/preview-stream/ws?${query}`;
}
export async function openBrowser(threadKey: string, profileId?: string) {
  const tab = parseBrowserTab(await threadClient(threadKey).call<unknown>("preview.open", {
    threadId: threadTarget(threadKey).threadId, runtime: "server", reveal: false,
    ...(profileId ? { profileId } : {}),
  }));
  if (tab.threadId !== threadTarget(threadKey).threadId || tab.runtime !== "server") throw new Error("This environment did not open a server browser");
  return tab;
}
export async function closeBrowser(threadKey: string, tabId: string) {
  await threadClient(threadKey).call("preview.close", { threadId: threadTarget(threadKey).threadId, tabId });
}
export function profileLabel(profileId: string | null) {
  return profileId === null ? "Profile not reported" : profileId === "default" ? "Default profile" : profileId === "incognito" ? "Incognito" : `Profile: ${profileId}`;
}

// v0.1.5 has no UI RPC or stream message for recording. Do not guess an RPC,
// impersonate an agent MCP session, or build a second recording backend.
export const BROWSER_TEACH_LIMITATION = "Browser demonstrations require a Bot running with T3’s recording tools. Recording from this view is not available on this runtime. A recording is a demonstration; creating a reusable skill is a separate step.";
