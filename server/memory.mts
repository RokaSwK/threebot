// A Bot's memory between sessions: a short `memory/MEMORY.md`, long-form notes under
// `memory/notes/`, and the facts every Bot shares in `.botapp/shared-memory.md`.
//
// The gateway renders a small, bounded snapshot of these files into the Bot's `AGENTS.md`, so a fresh
// session starts knowing what the Bot was told to remember. The full files stay on disk; the snapshot
// only carries what fits, plus an index of the notes that can be read on demand.
//
// This module is the single owner of reading, checking, writing and hashing memory. The MCP tools, the
// memory tab and the consolidation routine are adapters over these functions; they must not write the
// files themselves.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** How much of each file goes into `AGENTS.md`, and how large the files may grow. */
export type MemoryLimits = {
  snapshotBotLines: number;
  snapshotBotChars: number;
  snapshotSharedLines: number;
  snapshotSharedChars: number;
  memoryLines: number;
  memoryChars: number;
  factChars: number;
  noteTokens: number;
  noteChars: number;
  noteCount: number;
  noteDepth: number;
};

export const MEMORY_LIMITS: Readonly<MemoryLimits> = Object.freeze({
  // The snapshot is paid for in every session, so it stays small. Detail belongs in notes.
  snapshotBotLines: 80,
  snapshotBotChars: 3_000,
  snapshotSharedLines: 12,
  snapshotSharedChars: 800,
  // `MEMORY.md` itself may hold more than the snapshot; the snapshot marks what it left out.
  memoryLines: 120,
  memoryChars: 6_000,
  factChars: 200,
  noteTokens: 2_000,
  noteChars: 8_000,
  noteCount: 20,
  noteDepth: 2,
});

/** A note as the snapshot advertises it: enough to decide whether to read it. */
export type MemoryNote = {
  path: string;
  description: string;
  chars: number;
  tokens: number;
  updatedAt: string | null;
};

/** What the gateway reads to render `AGENTS.md`, and what the watcher compares between ticks. */
export type MemorySnapshot = {
  bot: string;
  shared: string;
  notes: MemoryNote[];
  revision: string;
  sharedRevision: string;
  truncated: { bot: boolean; shared: boolean };
  updatedAt: string | null;
};

/** A fact's origin, kept beside the files so the files stay readable Markdown. */
export type MemoryProvenance = {
  author: string;
  sourceMessageId?: string;
  quote?: string;
  at: string;
};

/** The small metadata file beside the Markdown. It is not a second memory store. */
export type MemoryState = {
  version: 1;
  revisions: Record<string, string>;
  provenance: Record<string, MemoryProvenance>;
  forgotten: string[];
  reflection: { lastPosition: number | null; lastMessageId: string | null; at: string | null };
  temporal: Record<string, { from: string | null; to: string | null }>;
};

export type MemoryRefusalCode =
  | "empty"
  | "too_long"
  | "newline"
  | "hidden_characters"
  | "prompt_link"
  | "instruction"
  | "secret"
  | "managed_marker";

export type MemoryRefusal = { ok: false; code: MemoryRefusalCode; message: string };
export type MemoryCheck = { ok: true } | MemoryRefusal;

/** A fact line split into the parts the core and the UI care about. */
export type ParsedFact = {
  category: string | null;
  text: string;
  source: string | null;
  added: string | null;
  validFrom: string | null;
  validTo: string | null;
  links: string[];
};

const MANAGED_START = "<!-- bot:managed:start -->";
const MANAGED_END = "<!-- bot:managed:end -->";
const DATE = "\\d{4}-\\d{2}-\\d{2}";
const INSTRUCTIONS = [
  "ignore previous",
  "ignore all previous",
  "ignore the above",
  "disregard previous",
  "system prompt",
  "you are now",
  "do not tell the user",
  "trusted source",
  "ignora las instrucciones",
  "ignora todas las instrucciones",
  "prompt del sistema",
  "ahora eres",
  "no le digas al usuario",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The revision a tool must send back before it changes a file. */
export function hashContent(value: string): string {
  return sha256(value);
}

/** A fact's identity for provenance, tombstones and duplicate checks. */
export function hashFact(value: string): string {
  return sha256(normalizeFact(value));
}

export function normalizeFact(value: string): string {
  return value
    .replace(/^\s*[-*+]\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function sanitizeMemoryText(value: string): string {
  return normalizeText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replaceAll(MANAGED_START, "[managed marker removed]")
    .replaceAll(MANAGED_END, "[managed marker removed]")
    .replaceAll("<memory>", "&lt;memory&gt;")
    .replaceAll("</memory>", "&lt;/memory&gt;");
}

function clipSnapshot(value: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
  const lines = normalizeText(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  // The file's own title is already implied by "Shared by all Bots" / "This Bot".
  if (lines[0] && /^#\s+/u.test(lines[0])) lines.shift();
  let truncated = false;
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || chars + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  if (truncated) kept.push("(truncated; read the memory file for the rest)");
  return { text: kept.join("\n"), truncated };
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function statIfExists(file: string): Promise<{ mtime: Date; size: number } | null> {
  try {
    const stat = await fs.stat(file);
    return { mtime: stat.mtime, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]!.toLowerCase()] = value;
  }
  return out;
}

function firstHeading(text: string): string | null {
  return /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? null;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function noteDescription(file: string, text: string): string {
  const fm = parseFrontmatter(text);
  return (fm.description || fm.title || firstHeading(text) || path.basename(file, ".md")).replace(/\s+/gu, " ").trim();
}

async function walkNotes(root: string, current: string, depth: number, maxDepth: number, out: MemoryNote[]): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkNotes(root, absolute, depth + 1, maxDepth, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const text = await readIfExists(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = await statIfExists(absolute);
      out.push({
        path: relative,
        description: noteDescription(absolute, text),
        chars: text.length,
        tokens: estimateTokens(text),
        updatedAt: stat?.mtime.toISOString() ?? null,
      });
    }
  }
}

/** The notes a Bot can read on demand, newest path order, capped. */
export async function listMemoryNotes(botDir: string, limits: Partial<MemoryLimits> = {}): Promise<MemoryNote[]> {
  const merged = { ...MEMORY_LIMITS, ...limits };
  const notes: MemoryNote[] = [];
  await walkNotes(botDir, path.join(botDir, "memory", "notes"), 0, merged.noteDepth, notes);
  return notes
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, merged.noteCount)
    .map((note) => ({ ...note, tokens: Math.min(note.tokens, merged.noteTokens) }));
}

/** Read the files a fresh session should see, bounded for the prompt. */
export async function readSnapshot({
  botDir,
  sharedFile,
  limits = {},
}: {
  botDir: string;
  sharedFile: string;
  limits?: Partial<MemoryLimits>;
}): Promise<MemorySnapshot> {
  const merged = { ...MEMORY_LIMITS, ...limits };
  const botFile = path.join(botDir, "memory", "MEMORY.md");
  const [botRaw, sharedRaw, notes] = await Promise.all([
    readIfExists(botFile),
    readIfExists(sharedFile),
    listMemoryNotes(botDir, merged),
  ]);
  const bot = clipSnapshot(sanitizeMemoryText(botRaw), merged.snapshotBotLines, merged.snapshotBotChars);
  const shared = clipSnapshot(sanitizeMemoryText(sharedRaw), merged.snapshotSharedLines, merged.snapshotSharedChars);
  const files = [botFile, sharedFile, ...notes.map((note) => path.join(botDir, note.path))];
  const stats = await Promise.all(files.map(statIfExists));
  const updatedAt = stats
    .flatMap((stat) => (stat ? [stat.mtime.getTime()] : []))
    .sort((a, b) => b - a)[0];
  return {
    bot: bot.text,
    shared: shared.text,
    notes,
    revision: hashContent(normalizeText(botRaw)),
    sharedRevision: hashContent(normalizeText(sharedRaw)),
    truncated: { bot: bot.truncated, shared: shared.truncated },
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

/** The `<memory>` block inside `AGENTS.md`. Memory is data; the delimiters make that explicit. */
export function renderMemoryBlock(snapshot: MemorySnapshot): string {
  if (!snapshot.shared.trim() && !snapshot.bot.trim() && snapshot.notes.length === 0) return "";
  const lines = ["<memory>", "### Shared by all Bots", snapshot.shared.trim() || "- (nothing saved yet)", "", "### This Bot", snapshot.bot.trim() || "- (nothing saved yet)"];
  if (snapshot.notes.length > 0) {
    lines.push("", "### Notes (read one when its description matches)");
    for (const note of snapshot.notes) {
      const description = note.description.replace(/[\r\n]+/gu, " ").replaceAll("`", "'").slice(0, 160);
      lines.push(`- \`${note.path}\` — ${description}`);
    }
  }
  lines.push("</memory>");
  return lines.join("\n");
}

function normalizeNotePath(notePath: string): string {
  const normalized = notePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized.startsWith("memory/notes/") || !normalized.toLowerCase().endsWith(".md") || normalized.includes("..") || normalized.includes("\0")) {
    throw Object.assign(new Error("A note path must be under memory/notes and end in .md"), { status: 400 });
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw Object.assign(new Error("A note path has an empty segment"), { status: 400 });
  }
  return normalized;
}

/** Read one note, refusing a path that escapes the Bot's notes folder (including through a symlink). */
export async function readMemoryNote(botDir: string, notePath: string, limits: Partial<MemoryLimits> = {}): Promise<string> {
  const merged = { ...MEMORY_LIMITS, ...limits };
  const normalized = normalizeNotePath(notePath);
  const notesRoot = path.join(botDir, "memory", "notes");
  const absolute = path.resolve(botDir, normalized);
  const rootReal = await fs.realpath(notesRoot).catch(() => null);
  const fileReal = await fs.realpath(absolute).catch(() => null);
  if (!rootReal || !fileReal || (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep))) {
    throw Object.assign(new Error("That note is outside this Bot's memory"), { status: 403 });
  }
  const text = await fs.readFile(fileReal, "utf8");
  if (text.length <= merged.noteChars) return text;
  return `${text.slice(0, merged.noteChars).trimEnd()}\n\n(truncated; read the note on disk for the rest)`;
}

function luhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) continue;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum > 0 && sum % 10 === 0;
}

function secretLike(text: string): boolean {
  const lower = text.toLowerCase();
  const labels = ["password", "passwd", "passcode", "api key", "api_key", "secret key", "token:", "contraseña", "clave api"];
  if (labels.some((label) => lower.includes(label))) return true;
  if (/(^|\s)(sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|akia|-----begin)/iu.test(text)) return true;
  if (/\b(?=[A-Za-z0-9+/=_-]{32,}\b)(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]+\b/u.test(text)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/u.test(text)) return true;
  const digits = text.match(/\b\d{13,19}\b/gu) ?? [];
  return digits.some((run) => luhn(run));
}

function stripFactSource(value: string): string {
  return value.replace(/\s*\[source:\s*[^\]]+\]\s*$/iu, "").trim();
}

/** Deterministic checks on what a fact may say. The model never gets to overrule these. */
export function checkFact(value: unknown): MemoryCheck {
  if (typeof value !== "string") return { ok: false, code: "empty", message: "A memory fact must be text." };
  const fact = stripFactSource(value).trim();
  if (!fact) return { ok: false, code: "empty", message: "A memory fact cannot be empty." };
  if (fact.length > MEMORY_LIMITS.factChars) {
    return { ok: false, code: "too_long", message: `Keep one fact to ${MEMORY_LIMITS.factChars} characters or fewer.` };
  }
  if (/[\r\n]/u.test(fact)) return { ok: false, code: "newline", message: "One fact per line; remove the line break." };
  if (/[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u.test(fact)) {
    return { ok: false, code: "hidden_characters", message: "The fact contains hidden or bidirectional characters." };
  }
  if (fact.includes(MANAGED_START) || fact.includes(MANAGED_END) || fact.includes("<memory>") || fact.includes("</memory>")) {
    return { ok: false, code: "managed_marker", message: "The fact contains a marker reserved for generated instructions." };
  }
  if (/[?&](q|prompt|query|instructions)=/iu.test(fact)) {
    return { ok: false, code: "prompt_link", message: "The fact contains a link that carries a prompt." };
  }
  const lower = fact.toLowerCase();
  if (INSTRUCTIONS.some((phrase) => lower.includes(phrase))) {
    return { ok: false, code: "instruction", message: "Memory holds facts about the user, not instructions to an assistant." };
  }
  if (secretLike(fact)) return { ok: false, code: "secret", message: "Passwords, keys, card numbers and identity numbers belong in the Vault, never in memory." };
  return { ok: true };
}

/** Split `- [category] @effective:date text [source: …] [[link]]` into its parts. */
export function parseFact(value: string): ParsedFact {
  let body = value.trim().replace(/^\s*[-*+]\s+/u, "");
  const sourceMatch = /\[source:\s*([^\]]+)\]/iu.exec(body);
  const source = sourceMatch?.[1]?.trim() ?? null;
  if (sourceMatch) body = body.replace(sourceMatch[0], "").trim();
  const added = source ? new RegExp(`added:\\s*(${DATE})`, "iu").exec(source)?.[1] ?? null : null;
  const categoryMatch = /^\[([a-z][a-z0-9_-]{0,32})\]\s*/iu.exec(body);
  const category = categoryMatch?.[1]?.toLowerCase() ?? null;
  if (categoryMatch) body = body.slice(categoryMatch[0].length).trim();
  const temporal = new RegExp(`@(effective|occurred|due|valid|mentioned)(?::(${DATE})|\\[(${DATE})?,(${DATE})?\\))`, "iu").exec(body);
  let validFrom: string | null = null;
  let validTo: string | null = null;
  if (temporal) {
    validFrom = temporal[2] ?? temporal[3] ?? null;
    validTo = temporal[4] ?? null;
    body = body.replace(temporal[0], "").trim();
  }
  const links = [...body.matchAll(/\[\[([^\]\n]{1,200})\]\]/gu)].map((match) => match[1]!.trim());
  return { category, text: body.trim(), source, added, validFrom, validTo, links };
}

/** One line in `MEMORY.md`, with optional category and provenance. */
export function formatFact(fact: string, { category = null, source = null, validFrom = null }: { category?: string | null; source?: string | null; validFrom?: string | null } = {}): string {
  const text = stripFactSource(fact).replace(/^\s*[-*+]\s+/u, "").trim();
  const head = category ? `[${category}] ` : "";
  const temporal = validFrom ? `@effective:${validFrom} ` : "";
  const origin = source ? ` [source: ${source.replace(/\]/gu, "")}]` : "";
  return `- ${head}${temporal}${text}${origin}`;
}

/** A stable key for a snapshot, so the watcher writes `AGENTS.md` only when something changed. */
export function memorySignature(snapshot: MemorySnapshot): string {
  return [snapshot.revision, snapshot.sharedRevision, ...snapshot.notes.map((note) => `${note.path}:${note.chars}:${note.description}`)].join("|");
}

function emptyState(): MemoryState {
  return {
    version: 1,
    revisions: {},
    provenance: {},
    forgotten: [],
    reflection: { lastPosition: null, lastMessageId: null, at: null },
    temporal: {},
  };
}

/** Read `.state.json`; a missing or damaged file starts clean rather than blocking the Bot. */
export async function readMemoryState(botDir: string): Promise<MemoryState> {
  const file = path.join(botDir, "memory", ".state.json");
  const raw = await readIfExists(file);
  if (!raw.trim()) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryState>;
    return {
      version: 1,
      revisions: parsed.revisions && typeof parsed.revisions === "object" && !Array.isArray(parsed.revisions) ? parsed.revisions : {},
      provenance: parsed.provenance && typeof parsed.provenance === "object" && !Array.isArray(parsed.provenance) ? parsed.provenance : {},
      forgotten: Array.isArray(parsed.forgotten) ? parsed.forgotten.filter((item): item is string => typeof item === "string") : [],
      reflection: {
        lastPosition: typeof parsed.reflection?.lastPosition === "number" ? parsed.reflection.lastPosition : null,
        lastMessageId: typeof parsed.reflection?.lastMessageId === "string" ? parsed.reflection.lastMessageId : null,
        at: typeof parsed.reflection?.at === "string" ? parsed.reflection.at : null,
      },
      temporal: parsed.temporal && typeof parsed.temporal === "object" && !Array.isArray(parsed.temporal) ? parsed.temporal : {},
    };
  } catch {
    return emptyState();
  }
}

/** Write a file through a temp name and rename, so a reader never sees half a file. */
export async function writeTextAtomic(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const existing = await fs.stat(file).catch(() => null);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode: mode ?? (existing ? existing.mode & 0o777 : 0o644) });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Save the metadata beside the Markdown. Called after the files it describes are written. */
export async function writeMemoryState(botDir: string, state: MemoryState): Promise<void> {
  const file = path.join(botDir, "memory", ".state.json");
  await writeTextAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/** A memory file changed by the user or another process, not through the core. */
export function revisionOf(content: string): string {
  return hashContent(normalizeText(content));
}
