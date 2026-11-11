// Settings → Machines: the machines this T3 Code has linked, and how the gateway reaches each one.
// T3 keeps the links (peerLinks.list, T3 0.1.9 and later, behind the `peerLinks` capability). The
// gateway reaches a linked machine two ways:
// - "linked": through the local T3, which forwards MCP tool calls to it (read and message threads).
// - "direct": with a session on that machine, from T3_ENVIRONMENTS_FILE or a pairing code entered
//   here. That one carries everything the app does locally: live threads, files and images.
// An older T3 without links leaves only the direct routes, as before.
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type MachineStatus = "online" | "asleep" | "unreachable" | "expired";
export type MachineRoute = "local" | "direct" | "linked" | "none";
export type Machine = {
  environmentId: string; label: string; local: boolean; status: MachineStatus; lastSeenAt: string | null;
  t3Version: string | null; threebotVersion: string | null; laptop: boolean; route: MachineRoute; paired: boolean;
  lastError: string | null;
};
/** One of T3's peer links, as peerLinks.list reports it; only the fields used here. */
export type PeerLink = { environmentId: string; label: string; urls: string[]; status: "reachable" | "unreachable" | "expired"; lastReachedAt: string | null; lastError: string | null };
export type Descriptor = { environmentId?: string; label?: string; serverVersion?: string; platform?: { machine?: string }; capabilities?: Record<string, unknown> };
type Cached = { label?: string; t3Version?: string | null; threebotVersion?: string | null; laptop?: boolean; lastSeenAt?: string | null; probedAt?: number };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const PROBE_EVERY = 10 * 60_000;
const THREEBOT_PORT = 3780;
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });

/** A machine's address the gateway may send a credential to: HTTPS, or HTTP on this machine. */
export function safeOrigin(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return null;
  return url.origin;
}

/** T3 only says reachable or not. A laptop that stops answering has almost always gone to sleep. */
export function machineStatus(link: Pick<PeerLink, "status">, laptop: boolean): MachineStatus {
  return link.status === "reachable" ? "online" : link.status === "expired" ? "expired" : laptop ? "asleep" : "unreachable";
}

/** The routes file paired machines are written to; T3_ENVIRONMENTS_FILE's entries win over it. */
export function pairedRoutesFile(appDir: string) { return path.join(appDir, "machines", "environments.json"); }

export function createMachines({ appDir, t3Url, version, localDescriptor, listLinks, routeFiles, fetcher = fetch, now = Date.now }: {
  appDir: string; t3Url: string; version: string;
  localDescriptor: () => Promise<Descriptor | null>;
  /** null: this T3 has no links (older than 0.1.9, or the token can't read them). */
  listLinks: () => Promise<PeerLink[] | null>;
  /** The direct routes, by environment, from every routes file. */
  routeFiles: () => Promise<Record<string, { baseUrl: string }>>;
  fetcher?: Fetch; now?: () => number;
}) {
  const cacheFile = path.join(appDir, "machines", "cache.json");
  const routesFile = pairedRoutesFile(appDir);
  let cache: Record<string, Cached> | null = null;
  let last: { at: number; value: Promise<{ machines: Machine[]; linksSupported: boolean; links: PeerLink[] }> } | null = null;

  const loadCache = async (): Promise<Record<string, Cached>> => cache ??= await readFile(cacheFile, "utf8").then((text) => JSON.parse(text) as Record<string, Cached>).catch((): Record<string, Cached> => ({}));
  const saveCache = async () => { await mkdir(path.dirname(cacheFile), { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache) + "\n", { mode: 0o600 }); };
  const get = async (url: string, ms: number) => {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(ms) }).catch(() => null);
    return response?.ok ? response.json().catch(() => null) : null;
  };

  /** What a machine says about itself without a credential, and whether a Threebot answers next to it. */
  async function probe(environmentId: string, urls: string[]) {
    const entry = (await loadCache())[environmentId] ??= {};
    if (entry.probedAt && now() - entry.probedAt < PROBE_EVERY) return;
    entry.probedAt = now();
    for (const url of urls) {
      const origin = safeOrigin(url) ?? (() => { try { return new URL(url).origin; } catch { return null; } })();
      if (!origin) continue;
      const descriptor: Descriptor | null = await get(origin + "/.well-known/t3/environment", 5000);
      if (descriptor?.environmentId !== environmentId) continue;
      entry.t3Version = descriptor.serverVersion ?? null;
      entry.laptop = descriptor.platform?.machine === "laptop";
      // Threebot's own health check on its default port, when it listens beyond loopback there.
      const host = new URL(origin).hostname;
      // A loopback address is this computer, whose Threebot is this one; the relay never fronts one.
      const health = host.endsWith(".t3coderelay.com") || ["127.0.0.1", "localhost", "[::1]"].includes(host) ? null : await get(`http://${host.includes(":") ? `[${host}]` : host}:${THREEBOT_PORT}/api/health`, 2000);
      entry.threebotVersion = typeof health?.version === "string" ? health.version : null;
      break;
    }
  }

  async function discover() {
    const [descriptor, links, routes] = await Promise.all([localDescriptor().catch(() => null), listLinks().catch(() => null), routeFiles().catch((): Record<string, { baseUrl: string }> => ({}))]);
    const store = await loadCache();
    const local: Machine = {
      environmentId: descriptor?.environmentId ?? "local", label: descriptor?.label ?? "This machine", local: true, status: descriptor ? "online" : "unreachable",
      lastSeenAt: descriptor ? new Date(now()).toISOString() : null, t3Version: descriptor?.serverVersion ?? null, threebotVersion: version,
      laptop: descriptor?.platform?.machine === "laptop", route: "local", paired: false, lastError: descriptor ? null : `T3 Code doesn't answer at ${t3Url}`,
    };
    const paired = new Set(Object.keys(await readRoutes(routesFile).catch((): Routes => ({}))));
    const machines: Machine[] = [local];
    const seen = new Set([local.environmentId]);
    for (const link of links ?? []) {
      if (!ID.test(link.environmentId) || seen.has(link.environmentId)) continue;
      seen.add(link.environmentId);
      if (link.status === "reachable") await probe(link.environmentId, link.urls ?? []);
      const entry = store[link.environmentId] ??= {};
      entry.label = link.label;
      if (link.status === "reachable") entry.lastSeenAt = new Date(now()).toISOString();
      const lastSeen = [entry.lastSeenAt, link.lastReachedAt].filter((value): value is string => typeof value === "string").sort().at(-1) ?? null;
      machines.push({
        environmentId: link.environmentId, label: link.label || entry.label || "Linked machine", local: false,
        status: machineStatus(link, entry.laptop === true), lastSeenAt: lastSeen, t3Version: entry.t3Version ?? null,
        threebotVersion: entry.threebotVersion ?? null, laptop: entry.laptop === true,
        route: routes[link.environmentId] || paired.has(link.environmentId) ? "direct" : link.status === "expired" ? "none" : "linked", paired: paired.has(link.environmentId), lastError: link.lastError,
      });
    }
    // Hand-configured machines T3 doesn't link: their own address says whether they answer.
    for (const [environmentId, route] of Object.entries(routes)) {
      if (!ID.test(environmentId) || seen.has(environmentId)) continue;
      seen.add(environmentId);
      const descriptor: Descriptor | null = await get(route.baseUrl + "/.well-known/t3/environment", 5000);
      const online = descriptor?.environmentId === environmentId;
      const entry = store[environmentId] ??= {};
      if (online) Object.assign(entry, { label: descriptor.label, t3Version: descriptor.serverVersion ?? null, laptop: descriptor.platform?.machine === "laptop", lastSeenAt: new Date(now()).toISOString() });
      machines.push({
        environmentId, label: entry.label ?? environmentId, local: false, status: online ? "online" : entry.laptop ? "asleep" : "unreachable",
        lastSeenAt: entry.lastSeenAt ?? null, t3Version: entry.t3Version ?? null, threebotVersion: entry.threebotVersion ?? null, laptop: entry.laptop === true,
        route: "direct", paired: paired.has(environmentId), lastError: online ? null : "Doesn't answer at its configured address",
      });
    }
    await saveCache().catch(() => {});
    return { machines, linksSupported: links !== null, links: links ?? [] };
  }

  /** Every machine; answers from a look at most `maxAge` old so the app and the monitor share one. */
  function list({ maxAge = 15_000 }: { maxAge?: number } = {}) {
    if (!last || now() - last.at > maxAge) {
      const value = discover();
      last = { at: now(), value };
      value.catch(() => { if (last?.value === value) last = null; });
    }
    return last.value;
  }

  /**
   * Swap a one-time pairing code from the other machine for a session there (T3's own token
   * exchange), and route that machine directly from now on.
   */
  async function pair(environmentId: string, code: string, explicitUrl?: string) {
    if (!ID.test(environmentId)) throw failure("Invalid machine");
    const pairing = String(code ?? "").trim();
    if (!pairing || pairing.length > 512 || /\s/.test(pairing)) throw failure("Enter the pairing code from the other machine");
    const { links } = await list({ maxAge: 0 });
    const candidates = explicitUrl ? [explicitUrl] : links.find((link) => link.environmentId === environmentId)?.urls ?? [];
    const origins = [...new Set(candidates.map(safeOrigin).filter((origin): origin is string => Boolean(origin)))];
    if (!origins.length) throw failure("Threebot doesn't know a secure address for this machine. Enter its HTTPS address.");
    let lastError = "The machine didn't answer.";
    for (const origin of origins) {
      const descriptor: Descriptor | null = await get(origin + "/.well-known/t3/environment", 8000);
      if (descriptor?.environmentId !== environmentId) { lastError = "That address answers as a different machine."; continue; }
      const response = await fetcher(origin + "/oauth/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: pairing,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap", requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          client_label: "Threebot", client_device_type: "bot",
        }) }).catch(() => null);
      const issued = response?.ok ? await response.json().catch(() => null) : null;
      if (typeof issued?.access_token !== "string" || !issued.access_token || /[\r\n]/.test(issued.access_token)) {
        lastError = response?.status === 400 || response?.status === 401 ? "That pairing code didn't work. Codes are used once and expire quickly; make a new one." : "The machine didn't accept the pairing code.";
        continue;
      }
      const tokenFile = path.join(path.dirname(routesFile), `${environmentId}.token`);
      await mkdir(path.dirname(routesFile), { recursive: true, mode: 0o700 });
      await writeFile(tokenFile, issued.access_token + "\n", { mode: 0o600 });
      const routes = await readRoutes(routesFile).catch((): Routes => ({}));
      routes[environmentId] = { baseUrl: origin, tokenFile };
      await writeFile(routesFile, JSON.stringify(routes, null, 2) + "\n", { mode: 0o600 });
      last = null;
      return { environmentId, baseUrl: origin };
    }
    throw failure(lastError, 502);
  }

  async function unpair(environmentId: string) {
    if (!ID.test(environmentId)) throw failure("Invalid machine");
    const routes = await readRoutes(routesFile).catch((): Routes => ({}));
    const route = routes[environmentId];
    if (!route) return { environmentId, paired: false };
    delete routes[environmentId];
    await writeFile(routesFile, JSON.stringify(routes, null, 2) + "\n", { mode: 0o600 });
    await rm(path.join(path.dirname(routesFile), `${environmentId}.token`), { force: true });
    last = null;
    return { environmentId, paired: false };
  }

  return { list, pair, unpair };
}
export type Machines = ReturnType<typeof createMachines>;

/** A routes file's entries; a file that isn't there has none. */
type Routes = Record<string, { baseUrl: string; tokenFile: string }>;
export async function readRoutes(file: string): Promise<Routes> {
  const stat = await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return {};
  const routes = JSON.parse(await readFile(file, "utf8"));
  return routes && typeof routes === "object" ? routes : {};
}
