// The Memory tab as the app sees it. The gateway reads the same Markdown files the Bots use and
// returns facts with their provenance; the tab never edits the files directly.

export type MemoryProvenance = {
  author: string;
  sourceMessageId?: string;
  quote?: string;
  at: string;
};

export type MemoryFact = {
  line: string;
  hash: string;
  category: string | null;
  text: string;
  source: string | null;
  added: string | null;
  validFrom: string | null;
  validTo: string | null;
  links: string[];
  provenance: MemoryProvenance | null;
};

export type MemoryLayer = {
  text: string;
  revision: string;
  truncated: boolean;
  facts: MemoryFact[];
};

export type MemoryNote = {
  path: string;
  description: string;
  chars: number;
  tokens: number;
  updatedAt: string | null;
};

export type MemoryView = {
  bot: MemoryLayer;
  shared: MemoryLayer;
  notes: MemoryNote[];
  forgotten: number;
  limits: {
    memoryLines: number;
    memoryChars: number;
    factChars: number;
    noteTokens: number;
    noteChars: number;
    noteCount: number;
  };
};

export type DefragFinding = {
  kind: "duplicate" | "near_duplicate" | "broken_link" | "orphan_note" | "oversized_note" | "stale_fact" | "possible_contradiction" | "over_budget";
  severity: "safe" | "review" | "info";
  detail: string;
  paths?: string[];
  lines?: string[];
};
export type DefragReport = {
  generatedAt: string;
  planPath: string | null;
  findings: DefragFinding[];
  counts: {
    facts: number; sharedFacts: number; notes: number; exactDuplicateFacts: number;
    nearDuplicateFacts: number; brokenLinks: number; oversizedNotes: number;
    staleFacts: number; possibleContradictions: number; overBudget: number;
  };
  safeDedupe: { bot: boolean; shared: boolean };
  limits: MemoryView["limits"];
};
export type DefragDedupe = {
  removed: number;
  bot: { ok: boolean; removed?: number; revision?: string };
  shared: { ok: boolean; removed?: number; revision?: string };
};
export type DefragResult = { report: DefragReport; dedupe: DefragDedupe | null };

export type MemoryForgetResult =
  | { ok: true; scope: "bot" | "shared"; path: string; revision: string; forgotten: string }
  | { ok: false; code: string; message: string; revision?: string; content?: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`), { body });
  return body as T;
}

export const memoryApi = {
  get: (slug: string) => request<MemoryView>(`/api/memory?slug=${encodeURIComponent(slug)}`),
  note: (slug: string, path: string) => request<{ path: string; text: string; revision: string }>(`/api/memory/note?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(path)}`),
  forget: (input: { slug: string; scope: "bot" | "shared"; fact: string; expectedRevision: string }) =>
    request<MemoryForgetResult>("/api/memory/forget", { method: "POST", body: JSON.stringify(input) }),
  defrag: (slug: string, applySafe = false) =>
    request<DefragResult>("/api/memory/defrag", { method: "POST", body: JSON.stringify({ slug, applySafe }) }),
};
