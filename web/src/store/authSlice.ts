import { api } from "../lib/api";
import { resetAssetCopies } from "../lib/assetCopies";
import { allT3Clients, t3, threadKey, threadTarget } from "../lib/t3";
import { clearCache, FORGET_CHANNEL, readBoot, stopCacheWrites, type CachedBoot } from "../lib/threadCache";
import type { Bot, Machine, Provider } from "../lib/types";
import { vaultApi } from "../lib/vault";
import { get, keepBoot, set, storeShared } from "./context";
import { startGatewayEvents } from "./events";
import { refreshBots, refreshRoutineAlerts, subscribeTasks } from "./botsSlice";
import { hydrateRooms, loadRoom, loadRooms, selectRoom } from "./roomsSlice";
import { flushCache, loadArchivedThreads, resubscribeThreads, subscribeShell } from "./threadsSlice";
import { openBotMap } from "./uiSlice";

let booted = false;
let runtimeStarted = false;
let bootRequest: Promise<void> | null = null;
let routeRoomOpened = false;
let forgetListener: BroadcastChannel | null = null;

export function boot(): Promise<void> {
  if (booted) return Promise.resolve();
  if (bootRequest) return bootRequest;
  bootRequest = Promise.resolve().then(initialize).finally(() => { bootRequest = null; });
  return bootRequest;
}

async function initialData() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Bot startup timed out"));
    }, 15_000);
  });
  try {
    return await Promise.race([
      Promise.all([api.config(controller.signal), api.settings(controller.signal), api.bots(controller.signal), api.botIdentities(controller.signal).catch(() => [])]),
      deadlinePromise,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function leaveLoginRoute() {
  if (!/\/login\/?$/.test(location.pathname)) return;
  const next = new URLSearchParams(location.search).get("next") ?? location.pathname.replace(/login\/?$/, "");
  const target = new URL(next, location.origin);
  history.replaceState(null, "", target.origin === location.origin ? target.pathname + target.search : location.pathname.replace(/login\/?$/, ""));
}

async function initialize() {
  set({ auth: "loading" });
  try {
    leaveLoginRoute();
    const cachedBoot = await readBoot();
    if (cachedBoot) {
      openFromCopy(cachedBoot);
      void confirmLaunch();
      return;
    }
    const session = await api.session();
    if (!session.authenticated) return signedOut(session);
    const [config, settings, bots, historical] = await initialData();
    set({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings, bots: Object.fromEntries(bots.map((b) => [b.slug, b])), historicalBots: Object.fromEntries(historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
    keepBoot({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings, bots, historical });
    openRoute(bots, historical);
    void loadRooms().catch(() => {});
    startRuntime();
    t3.connect();
    void loadVault();
    void loadMachines();
    void refreshRoutineAlerts();
    booted = true;
    set({ auth: "ready" });
  } catch {
    set({ auth: "error" });
  }
}

async function confirmLaunch() {
  const session = await api.session().catch(() => null);
  if (!session) return get().connection === "open" ? undefined : set({ offline: true });
  if (!session.authenticated) return signedOut(session);
  try {
    const revision = storeShared.botsRevision;
    const [config, settings, bots, historical] = await initialData();
    if (get().auth !== "ready") return;
    set({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings });
    if (revision === storeShared.botsRevision && !storeShared.pendingBotMutations) {
      set({ bots: Object.fromEntries(bots.map((b) => [b.slug, b])), historicalBots: Object.fromEntries(historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
      keepBoot({ botsRoot: config.botsRoot, executorUrl: config.executorUrl ?? null, settings, bots, historical });
    }
    openRoute(Object.values(get().bots), Object.values(get().historicalBots));
    void loadRooms().catch(() => {});
    void loadVault();
    void loadMachines();
    void refreshRoutineAlerts();
  } catch {
    // The gateway answered the session but not the rest: the copy stays, the socket keeps trying.
  }
}

function openRoute(bots: Bot[], historical: Bot[]) {
  const route = new URLSearchParams(location.search);
  const routeRoom = /^[A-Za-z0-9_-]{1,64}$/.test(route.get("room")?.trim() ?? "") ? route.get("room")!.trim() : null;
  const routeBot = bots.find((b) => b.slug === route.get("bot")) ?? historical.find((b) => `archived:${b.mainThreadId}` === route.get("bot"));
  if (!routeBot && route.get("environment") && route.get("thread")) set({ selected: bots.find((bot) => bot.slug === get().selected)?.slug ?? bots.find((bot) => bot.primary)?.slug ?? bots[0]?.slug ?? null, selectedThreadId: threadKey({ environmentId: route.get("environment")!, threadId: route.get("thread")! }) });
  if (route.get("page") === "projects" || route.get("item")) set({ page: "projects", projectItemId: /^[a-z0-9]{4,24}$/.test(route.get("item") ?? "") ? route.get("item") : null });
  else if (route.get("page") === "map") openBotMap();
  if (routeBot) set({ selected: bots.includes(routeBot) ? routeBot.slug : `archived:${routeBot.mainThreadId}`, selectedThreadId: route.get("thread") && route.get("environment") ? threadKey({ environmentId: route.get("environment")!, threadId: route.get("thread")! }) : route.get("thread"), exchangeBotSlug: bots.some((b) => b.slug === route.get("exchange")) ? route.get("exchange") : null });
  if (routeRoom && !routeRoomOpened) {
    routeRoomOpened = true;
    selectRoom(routeRoom);
  }
}

function openFromCopy(cachedBoot: CachedBoot) {
  storeShared.copied = true;
  set({ botsRoot: cachedBoot.botsRoot, executorUrl: cachedBoot.executorUrl, settings: cachedBoot.settings, bots: Object.fromEntries(cachedBoot.bots.map((b) => [b.slug, b])), historicalBots: Object.fromEntries(cachedBoot.historical.map((b) => [`archived:${b.mainThreadId}`, b])) });
  openRoute(cachedBoot.bots, cachedBoot.historical);
  void hydrateRooms();
  void loadRooms().catch(() => {});
  startRuntime();
  t3.connect();
  booted = true;
  set({ auth: "ready", offline: navigator.onLine === false });
}

export function signedOut(session: { accessLogin: boolean; passwordRequired: boolean }) {
  void forgetDeviceCopy();
  set({ auth: session.accessLogin ? "access" : session.passwordRequired ? "password" : "error" });
}

async function loadProviders() {
  const cfg = await t3.call("server.getConfig", {}).catch(() => null);
  if (cfg) {
    set({
      providers: cfg.providers.filter((p: Provider) => p.enabled && p.status === "ready"),
      providerModelPreferences: cfg.settings?.providerModelPreferences ?? {},
      runtimeFeatures: { shellOlderSettled: cfg.shellOlderSettled === true, threadFind: cfg.threadFind === true, threadResumeCompletionMarker: cfg.threadResumeCompletionMarker === true, sideChats: cfg.environment?.capabilities?.sideChats === true, threadForceStop: cfg.environment?.capabilities?.threadForceStop === true, voiceTranscription: cfg.environment?.capabilities?.voiceTranscription === true, freshContext: cfg.environment?.capabilities?.freshContext === true, scheduledTaskThreadModes: cfg.environment?.capabilities?.scheduledTaskThreadModes === true },
      snoozePresets: cfg.settings?.snoozePresets ?? [],
      fallbackModel: cfg.settings?.fallbackModelSelection ?? null,
    });
  }
}

function startRuntime() {
  if (runtimeStarted) return;
  let live = false;
  let failures = 0;
  t3.onState((connection) => {
    if (connection === "open") {
      const was = get().offline;
      live = true;
      failures = 0;
      set({ connection, offline: false });
      if (storeShared.copied && was) announce("Connected");
      return;
    }
    if (connection !== "closed") return set({ connection });
    failures++;
    const known = navigator.onLine === false || live;
    const offlineNow = known || get().offline || (storeShared.copied && failures >= 2);
    if (offlineNow && !get().offline) announce(navigator.onLine === false ? "Offline. Showing saved copies." : "Disconnected. Showing saved copies.");
    set({ connection, offline: offlineNow });
  });
  t3.onReconnect(() => {
    subscribeShell();
    subscribeTasks();
    void loadProviders();
    void loadArchivedThreads();
    resubscribeThreads();
  });
  const resyncRooms = () => {
    void loadRooms().catch(() => {});
    const roomId = get().selectedRoom;
    if (roomId) void loadRoom(roomId, true);
  };
  const wake = () => {
    if (document.visibilityState === "visible") {
      for (const client of allT3Clients()) client.checkAlive();
    }
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", () => {
    if (get().offline && get().connection === "open") {
      set({ offline: false });
      announce("Connected");
    }
    wake();
    void refreshBots();
    resyncRooms();
    void loadMachines();
  });
  window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushCache(); });
  window.addEventListener("pagehide", flushCache);
  try {
    forgetListener = new BroadcastChannel(FORGET_CHANNEL);
    forgetListener.onmessage = () => stopSaving();
    (forgetListener as BroadcastChannel & { unref?: () => void }).unref?.();
  } catch { /* a single tab is all there is */ }
  window.addEventListener("offline", () => {
    if (!get().offline) announce(storeShared.copied ? "Offline. Showing saved copies." : "Offline.");
    set({ offline: true });
  });
  // Event-driven updates via /api/events SSE (replaces 5s bot poll, 2s room poll, and 60s machine poll).
  startGatewayEvents({
    onBots: () => { if (navigator.onLine !== false) void refreshBots(); },
    onRooms: resyncRooms,
    onMachines: () => { if (navigator.onLine !== false) void loadMachines(true); },
    onReconnect: () => {
      void refreshBots();
      resyncRooms();
      void loadMachines();
    },
  });
  runtimeStarted = true;
}

export function resetBootForTest() {
  booted = false;
  bootRequest = null;
  routeRoomOpened = false;
  storeShared.forgetting = false;
}

let clearAnnouncement: ReturnType<typeof setTimeout> | undefined;
export function announce(text: string) {
  clearTimeout(clearAnnouncement);
  set({ announcement: text });
  clearAnnouncement = setTimeout(() => set({ announcement: "" }), 4_000);
}

export async function forgetDeviceCopy() {
  try { const channel = new BroadcastChannel(FORGET_CHANNEL); channel.postMessage("forget"); channel.close(); } catch { /* no other tabs to tell */ }
  stopSaving();
  await clearCache().catch(() => {});
}

function stopSaving() {
  storeShared.forgetting = true;
  for (const timer of storeShared.cacheTimers.values()) clearTimeout(timer);
  storeShared.cacheTimers.clear();
  stopCacheWrites();
  resetAssetCopies();
}

export async function loadVault() {
  const items = await vaultApi.list().catch(() => null);
  if (items) set({ vault: items });
  return items;
}

export async function loadMachines(fresh = false) {
  const result = await api.machines(fresh).catch(() => null);
  if (result) set({ machines: result.machines });
  return result;
}

export function machineOf(threadId: string | null | undefined, machines = get().machines): Machine | undefined {
  const environmentId = threadId ? threadTarget(threadId).environmentId : undefined;
  return environmentId ? machines?.find((machine) => machine.environmentId === environmentId) : undefined;
}

export function linkedOnly(threadId: string | null | undefined) {
  const machine = machineOf(threadId);
  return machine?.route === "linked" || machine?.route === "none";
}
