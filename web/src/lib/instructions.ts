// The Instructions tab as the app sees it: the owner's part of a Bot's `AGENTS.md`,
// after the block Threebot manages. Saves carry the revision they started from, so they
// never silently replace an edit the Bot made in the meantime.

export type InstructionFile = {
  path: string;
  text: string;
  revision: string;
  bytes: number;
  totalBytes: number;
  maxChars: number;
  warnAt: number;
  maxTotalBytes: number;
  managed: boolean;
};

export type InstructionSaveResult =
  | { ok: true; revision: string; bytes: number; totalBytes: number }
  | { ok: false; code: "conflict"; message: string; revision: string; text: string }
  | { ok: false; code: "invalid"; message: string };

async function request<T>(path: string, init: RequestInit = {}, { allowConflict = false }: { allowConflict?: boolean } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  // A save conflict is an answer the tab handles. A GET's 409 (an adopted Bot) is a failure:
  // treating it as a file would hand the component an object with no text and crash its render.
  if (!res.ok && !(allowConflict && res.status === 409)) throw Object.assign(new Error(body?.error ?? body?.message ?? `HTTP ${res.status}`), { body });
  return { status: res.status, body: body as T };
}

export const instructionsApi = {
  get: async (slug: string) => (await request<InstructionFile>(`/api/instructions?slug=${encodeURIComponent(slug)}`)).body,
  save: async (input: { slug: string; text: string; expectedRevision: string }) =>
    (await request<InstructionSaveResult>("/api/instructions", { method: "PUT", body: JSON.stringify(input) }, { allowConflict: true })).body,
};

/** The short example the empty state and the editor placeholder show. Not written to the file. */
export const INSTRUCTIONS_EXAMPLE =
  "## What this Bot does\n- Review code changes and tell me what blocks a merge.\n\n## What this Bot doesn't do\n- Don't push or open a PR without asking me.\n\n## How this Bot talks\n- Spanish, direct, technical.";
