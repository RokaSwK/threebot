import type { Bot, Settings, ThreadMeta, ThreadPreview } from "./types";

type Session = { authenticated: boolean; passwordRequired: boolean; accessLogin: boolean };

async function session(): Promise<Session> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("/api/session", { signal: controller.signal, redirect: "manual", cache: "no-store" });
    // Cloudflare Access answers an ended session with a redirect to its login host.
    if (response.type === "opaqueredirect") return { authenticated: false, passwordRequired: false, accessLogin: true };
    if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("Couldn't verify your session.");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("authenticated" in value) || typeof value.authenticated !== "boolean"
      || !("passwordRequired" in value) || typeof value.passwordRequired !== "boolean"
      || !("accessLogin" in value) || typeof value.accessLogin !== "boolean") throw new Error("Couldn't verify your session.");
    return { authenticated: value.authenticated, passwordRequired: value.passwordRequired, accessLogin: value.accessLogin };
  } finally {
    clearTimeout(timer);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init.body ? { "content-type": "application/json", ...(init.headers ?? {}) } : init.headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

export const api = {
  session,
  login: (password: string) => req("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout"),
  config: (signal?: AbortSignal) => req<{ botsRoot: string; accessLogout?: boolean; executorUrl?: string | null }>("/api/config", { signal }),
  settings: (signal?: AbortSignal) => req<Settings>("/api/settings", { signal }),
  saveSettings: (patch: Partial<Settings>) => req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  bots: (signal?: AbortSignal) => req<{ bots: Bot[] }>("/api/bots", { signal }).then((r) => r.bots),
  botIdentities: (signal?: AbortSignal) => req<{ bots: Bot[] }>("/api/bot-identities", { signal }).then((r) => r.bots),
  createBot: (input: Partial<Bot>) => req<Bot>("/api/bots", { method: "POST", body: JSON.stringify(input) }),
  saveBot: (slug: string, patch: Partial<Bot>) => req<Bot>(`/api/bots/${slug}`, { method: "PUT", body: JSON.stringify(patch) }),
  setMainBot: (slug: string) => req<{ bots: Bot[] }>("/api/main-bot", { method: "PUT", body: JSON.stringify({ slug }) }),
  deleteBot: (slug: string) => req<{ ok: true; bots: Bot[] }>(`/api/bots/${slug}`, { method: "DELETE" }),
  threadPreviews: (stamps: Record<string, string>) => req<{ previews: Record<string, ThreadPreview> }>("/api/thread-previews", { method: "POST", body: JSON.stringify({ stamps }) }).then((r) => r.previews),
  threadMeta: (threadId: string) => req<ThreadMeta>(`/api/thread-meta?thread=${encodeURIComponent(threadId)}`),
  toggleReaction: (threadId: string, itemId: string, emoji: string) => req<ThreadMeta>("/api/thread-meta/reactions", { method: "POST", body: JSON.stringify({ threadId, itemId, emoji }) }),
  addVoiceCall: (threadId: string, seconds: number) => req<ThreadMeta>("/api/thread-meta/voice-calls", { method: "POST", body: JSON.stringify({ threadId, seconds }) }),
};

/** Behind Cloudflare Access, signing out means ending the Access session too. Ask before the local session goes. */
export async function signOutTarget() {
  try { return (await api.config()).accessLogout ? "/cdn-cgi/access/logout" : "/"; } catch { return "/"; }
}
