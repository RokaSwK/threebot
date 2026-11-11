// The Memory tab as the app sees it: a Bot's `memory/MEMORY.md` and the shared memory file,
// whole, as plain text. Saves carry the revision they started from, so they never silently
// replace an edit the Bot made in the meantime.

export type MemoryScope = "bot" | "shared";

export type MemoryFile = { path: string; text: string; revision: string };

export type MemoryFiles = { bot: MemoryFile; shared: MemoryFile };

export type MemorySaveResult =
  | { ok: true; revision: string }
  | { ok: false; code: "conflict"; message: string; revision: string; text: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  // A conflict is an answer the tab handles, not a failure.
  if (!res.ok && res.status !== 409) throw Object.assign(new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`), { body });
  return { status: res.status, body: body as T };
}

export const memoryApi = {
  get: async (slug: string) => (await request<MemoryFiles>(`/api/memory?slug=${encodeURIComponent(slug)}`)).body,
  save: async (input: { slug: string; scope: MemoryScope; text: string; expectedRevision: string }) =>
    (await request<MemorySaveResult>("/api/memory", { method: "PUT", body: JSON.stringify(input) })).body,
};
