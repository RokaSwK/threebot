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

/** The parts of a T3 message the memory evidence check uses. */
export type MemoryMessage = {
  id: string;
  text: string;
  createdBy?: string;
  creationSource?: string;
  attachments?: unknown[];
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
      const description = note.description.replace(/\r?\n/gu, " ").replaceAll("`", "'").replaceAll("<memory>", "&lt;memory&gt;").replaceAll("</memory>", "&lt;/memory&gt;").slice(0, 160);
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
  if (segments.length > 5) {
    throw Object.assign(new Error("A note path may have at most two folder levels under memory/notes"), { status: 400 });
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

// A label marks a secret only when a value follows it ("password: …", "token is …"). A fact that
// merely talks about passwords ("password resets go through Ana") is not one.
const SECRET_LABEL = /(?:^|[^\p{L}\p{N}])(?:password|passwd|passcode|api[ _-]?key|secret[ _-]?key|token|contraseña|clave api)\s*(?:[:=]|\s(?:is|es)\s)\s*\S/iu;

/** A long unbroken run with a digit in it: a key or token, as far as anyone can tell by looking. */
function opaqueRun(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9+/=_-]{32,}/gu) ?? []) {
    if (!/\d/u.test(run)) continue;
    // Paths, slugs and ids are made of short pieces (memory/notes/threebot-landing-v2, a thread's
    // UUID); a key is one long piece. A full commit hash still counts: quote its first 12 characters.
    if (run.split(/[/_-]+/u).some((piece) => piece.length > 16)) return true;
  }
  return false;
}

function secretReason(text: string): "secret" | "opaque" | null {
  if (SECRET_LABEL.test(text)) return "secret";
  if (/(^|\s)(sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|akia|-----begin)/iu.test(text)) return "secret";
  if (/\b\d{3}-\d{2}-\d{4}\b/u.test(text)) return "secret";
  const digits = text.match(/\b\d{13,19}\b/gu) ?? [];
  if (digits.some((run) => luhn(run))) return "secret";
  return opaqueRun(text) ? "opaque" : null;
}

function secretRefusal(text: string, where: "memory" | "a note"): MemoryRefusal | null {
  const reason = secretReason(text);
  if (!reason) return null;
  return {
    ok: false,
    code: "secret",
    message: reason === "opaque"
      ? `That has a long unbroken string that looks like a key or token, which belongs in the Vault, never in ${where}. If it is a commit hash or an id, shorten it (12 characters is enough).`
      : `Passwords, keys, card numbers and identity numbers belong in the Vault, never in ${where}.`,
  };
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
  return secretRefusal(fact, "memory") ?? { ok: true };
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
  return readMemoryStateFile(path.join(botDir, "memory", ".state.json"));
}

/** Read a state file at an explicit path (the shared memory has its own). */
export async function readMemoryStateFile(file: string): Promise<MemoryState> {
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
  await writeMemoryStateFile(path.join(botDir, "memory", ".state.json"), state);
}

/** Save a state file at an explicit path (the shared memory has its own). */
export async function writeMemoryStateFile(file: string, state: MemoryState): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/** Remember through which transcript position reflection has already looked. */
export async function writeReflectionBookmark(botDir: string, input: { position: number | null; messageId: string | null; at?: Date }): Promise<void> {
  const state = await readMemoryState(botDir);
  state.reflection = {
    lastPosition: input.position,
    lastMessageId: input.messageId,
    at: (input.at ?? new Date()).toISOString(),
  };
  await writeMemoryState(botDir, state);
}

/** A short, human-readable review log. It is not a memory source. */
export async function appendDream(botDir: string, line: string): Promise<void> {
  const file = path.join(botDir, "memory", "DREAMS.md");
  const existing = await readIfExists(file);
  const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}- ${line}\n`;
  await writeTextAtomic(file, next, 0o644);
}

/** What the Memory tab shows: facts split into bot/shared, with their provenance. */
export type MemoryFactView = ParsedFact & {
  line: string;
  hash: string;
  provenance: MemoryProvenance | null;
};
export type MemoryView = {
  bot: { text: string; revision: string; truncated: boolean; facts: MemoryFactView[] };
  shared: { text: string; revision: string; truncated: boolean; facts: MemoryFactView[] };
  notes: MemoryNote[];
  forgotten: number;
  limits: MemoryLimits;
};

/** Read both memory layers, their parsed facts and provenance for the Memory tab. */
export async function readMemoryView({ botDir, sharedFile, limits = {} }: { botDir: string; sharedFile: string; limits?: Partial<MemoryLimits> }): Promise<MemoryView> {
  const merged = { ...MEMORY_LIMITS, ...limits };
  const [bot, shared, botState, sharedState, notes] = await Promise.all([
    readMemoryText({ botDir, sharedFile, scope: "bot", limits: merged }),
    readMemoryText({ botDir, sharedFile, scope: "shared", limits: merged }),
    readMemoryState(botDir),
    readMemoryStateFile(path.join(path.dirname(sharedFile), "shared-memory.state.json")),
    listMemoryNotes(botDir, merged),
  ]);
  const parse = (text: string, state: MemoryState): MemoryFactView[] =>
    normalizeText(text)
      .split("\n")
      .filter((line) => /^\s*[-*+]\s+/u.test(line))
      .map((raw) => {
        const line = raw.trim();
        const parsed = parseFact(line);
        const hash = hashFact(parsed.text);
        return { ...parsed, line, hash, provenance: state.provenance[hash] ?? null };
      });
  return {
    bot: { ...bot, facts: parse(bot.text, botState) },
    shared: { ...shared, facts: parse(shared.text, sharedState) },
    notes,
    forgotten: new Set([...botState.forgotten, ...sharedState.forgotten]).size,
    limits: merged,
  };
}

/** A memory file changed by the user or another process, not through the core. */
export function revisionOf(content: string): string {
  return hashContent(normalizeText(content));
}

// ---------- evidence, mutations, history and search ----------
// The checks below are the write boundary. The model proposes; these rules decide. Nothing in
// this section calls a model, and nothing here trusts a fact because it sounds plausible.

/** The user's own words, after removing the parts T3 cannot prove were typed by them. */
const FORWARD_MARKERS = [
  /^-{2,}\s*forwarded message/iu,
  /^forwarded message/iu,
  /^begin forwarded message/iu,
  /^-{2,}\s*mensaje reenviado/iu,
  /^mensaje reenviado/iu,
];
const ACKNOWLEDGEMENTS = new Set([
  "ok", "okay", "okey", "yes", "no", "thanks", "thank you", "got it", "sure", "cool",
  "dale", "listo", "perfecto", "gracias", "sí", "si", "vale", "bien", "claro", "de acuerdo",
]);

function evidenceText(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Runs of text that came from the user's own typing. Fenced code, blockquotes and forwarded
 * blocks are removed; a quote that only exists there is not evidence of what the user believes.
 * T3 does not expose a per-range `pasted` flag, so this is a line-level approximation.
 */
export function typedRuns(text: string): string[] {
  if (typeof text !== "string") return [];
  const runs: string[] = [];
  let current: string[] = [];
  let fenced = false;
  let forwarded = false;
  const flush = () => {
    if (current.length) runs.push(current.join(" "));
    current = [];
  };
  for (const line of normalizeText(text).split("\n")) {
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) continue;
    if (trimmed.startsWith(">") || trimmed.startsWith("＞")) {
      flush();
      continue;
    }
    if (FORWARD_MARKERS.some((marker) => marker.test(trimmed))) {
      forwarded = true;
      flush();
      continue;
    }
    if (forwarded) {
      if (!trimmed) forwarded = false;
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    current.push(trimmed);
  }
  flush();
  return runs;
}

export type EvidenceCheck =
  | { ok: true; quote: string }
  | { ok: false; code: "missing" | "too_short" | "acknowledgement" | "not_typed"; message: string };

/** Is `quote` a substantive phrase the user actually typed in `text`? */
export function checkOwnerEvidence(text: string, quote: string): EvidenceCheck {
  if (typeof text !== "string" || typeof quote !== "string" || !text.trim() || !quote.trim()) {
    return { ok: false, code: "missing", message: "Pass the user's exact words in sourceQuote." };
  }
  const normalizedQuote = evidenceText(quote);
  if (!normalizedQuote) return { ok: false, code: "missing", message: "sourceQuote is empty." };
  if (normalizedQuote.split(" ").length < 3) {
    return { ok: false, code: "too_short", message: "sourceQuote is too short to be evidence. Quote a full phrase." };
  }
  if (ACKNOWLEDGEMENTS.has(normalizedQuote)) {
    return { ok: false, code: "acknowledgement", message: "An acknowledgement is not evidence of a lasting fact." };
  }
  const runs = typedRuns(text).map(evidenceText);
  if (!runs.some((run) => run.includes(normalizedQuote))) {
    return {
      ok: false,
      code: "not_typed",
      message: "That text was pasted, quoted, in a code block, forwarded or written by a Bot, not typed by the user. Ask the user to state the fact in their own words.",
    };
  }
  return { ok: true, quote: quote.trim() };
}

export type MemoryScope = "bot" | "shared";
export type MemoryMutationOp = "add" | "replace" | "supersede" | "note" | "forget";

export type MemoryMutationInput = {
  botDir: string;
  sharedFile: string;
  scope: MemoryScope;
  op: MemoryMutationOp;
  expectedRevision: string;
  author: string;
  sourceMessageId: string;
  sourceQuote: string;
  sourceText: string;
  fact?: string;
  old?: string;
  new?: string;
  category?: string | null;
  path?: string;
  description?: string;
  content?: string;
  validFrom?: string | null;
  restore?: boolean;
  /** The Memory tab acts as the signed-in user; no transcript quote is involved. */
  trustedUser?: boolean;
  now?: Date;
};

export type MemoryMutationResult =
  | { ok: true; scope: MemoryScope; path: string; revision: string; line?: string; forgotten?: string; note?: string }
  | { ok: false; code: "conflict" | "not_found" | "duplicate" | "forgotten" | "invalid" | "cap" | "path" | "unsupported"; message: string; revision?: string; content?: string };

type MemoryFileContext = {
  scope: MemoryScope;
  file: string;
  stateFile: string;
  historyDir: string;
  journalDir: string;
  relative: string;
  label: string;
};

function memoryFileContext(botDir: string, sharedFile: string, scope: MemoryScope): MemoryFileContext {
  if (scope === "shared") {
    const dir = path.dirname(sharedFile);
    return {
      scope,
      file: sharedFile,
      stateFile: path.join(dir, "shared-memory.state.json"),
      historyDir: path.join(dir, "shared-memory.history"),
      journalDir: path.join(dir, "shared-memory.journal"),
      relative: "shared-memory.md",
      label: "shared-memory",
    };
  }
  return {
    scope,
    file: path.join(botDir, "memory", "MEMORY.md"),
    stateFile: path.join(botDir, "memory", ".state.json"),
    historyDir: path.join(botDir, "memory", "history"),
    journalDir: path.join(botDir, "memory", ".journal"),
    relative: "MEMORY.md",
    label: "MEMORY",
  };
}

function localDate(now: Date): string {
  const shifted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sourceLabel(messageId: string, now: Date): string {
  return `thread/${messageId}; added: ${localDate(now)}`;
}

function factKey(line: string): string {
  return hashFact(parseFact(line).text);
}

function factLines(content: string): { lines: string[]; trailing: boolean } {
  const trailing = content.endsWith("\n");
  const lines = normalizeText(content).split("\n");
  if (trailing) lines.pop();
  return { lines, trailing };
}

function joinLines(lines: string[], trailing: boolean): string {
  return `${lines.join("\n")}${trailing ? "\n" : ""}`;
}

function findFactLine(lines: string[], value: unknown): { index: number } | { error: MemoryMutationResult } {
  const wanted = typeof value === "string" ? value.trim() : "";
  if (!wanted) return { error: { ok: false, code: "invalid", message: "Pass the exact existing fact in old." } };
  const matches = lines.map((line, index) => ({ line: line.trim(), index })).filter((item) => item.line === wanted);
  if (matches.length === 0) return { error: { ok: false, code: "not_found", message: "That fact isn't in this memory file. Read it again before replacing or forgetting it." } };
  if (matches.length > 1) return { error: { ok: false, code: "invalid", message: "That fact appears more than once. Read the file and remove the duplicate first." } };
  return { index: matches[0]!.index };
}

function noteFrontmatter(description: string, title: string): string {
  const clean = (value: string) => value.replace(/[\r\n]+/gu, " ").replace(/"/gu, "'").trim();
  return `---\ndescription: ${clean(description)}\ntitle: ${clean(title)}\ntype: note\n---\n`;
}

function checkNoteContent(content: string): MemoryCheck {
  if (content.length > MEMORY_LIMITS.noteChars) {
    return { ok: false, code: "too_long", message: `Keep a note to ${MEMORY_LIMITS.noteChars} characters or fewer.` };
  }
  if (/[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u.test(content)) {
    return { ok: false, code: "hidden_characters", message: "The note contains hidden or bidirectional characters." };
  }
  if (content.includes(MANAGED_START) || content.includes(MANAGED_END) || content.includes("<memory>") || content.includes("</memory>")) {
    return { ok: false, code: "managed_marker", message: "The note contains a marker reserved for generated instructions." };
  }
  return secretRefusal(content, "a note") ?? { ok: true };
}

async function writeHistory(ctx: MemoryFileContext, before: string, now: Date): Promise<void> {
  try {
    await fs.mkdir(ctx.historyDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/gu, "-");
    const file = path.join(ctx.historyDir, `${stamp}-${ctx.label}.md`);
    await writeTextAtomic(file, before, 0o600);
    // Keep the last 50 preimages or 30 days, whichever is longer.
    const entries = (await fs.readdir(ctx.historyDir)).filter((name) => name.endsWith(".md"));
    const stats = await Promise.all(entries.map(async (name) => {
      const absolute = path.join(ctx.historyDir, name);
      const stat = await fs.stat(absolute).catch(() => null);
      return stat ? { name, time: stat.mtimeMs } : null;
    }));
    const kept = stats.filter((entry): entry is { name: string; time: number } => Boolean(entry)).sort((a, b) => b.time - a.time);
    const cutoff = now.getTime() - 30 * 24 * 3600 * 1000;
    for (const [index, entry] of kept.entries()) {
      if (index < 50 && entry.time >= cutoff) continue;
      await fs.rm(path.join(ctx.historyDir, entry.name), { force: true }).catch(() => {});
    }
  } catch (error) {
    // History is an audit aid; a failure here must not block the write.
    console.error("writing memory history failed", error);
  }
}

type MemoryJournal = {
  version: 1;
  opId: string;
  file: string;
  beforeHash: string;
  after: string;
  stateFile: string;
  beforeState: MemoryState;
  afterState: MemoryState;
  createdAt: string;
};

async function writeJournal(ctx: MemoryFileContext, before: string, after: string, beforeState: MemoryState, afterState: MemoryState, now: Date): Promise<string> {
  await fs.mkdir(ctx.journalDir, { recursive: true });
  const opId = randomUUID();
  const journal: MemoryJournal = {
    version: 1,
    opId,
    file: ctx.file,
    beforeHash: revisionOf(before),
    after,
    stateFile: ctx.stateFile,
    beforeState,
    afterState,
    createdAt: now.toISOString(),
  };
  await writeTextAtomic(path.join(ctx.journalDir, `${opId}.json`), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  return opId;
}

async function recoverJournalDir(dir: string, root: string, log: (line: string) => void): Promise<void> {
  let names: string[];
  try {
    // A journal set aside as failed-… was refused once and is kept for review; it is never retried.
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json") && !name.startsWith("failed-"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const rootPath = path.resolve(root);
  for (const name of names) {
    const journalPath = path.join(dir, name);
    let journal: MemoryJournal;
    try {
      journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as MemoryJournal;
    } catch {
      await fs.rename(journalPath, path.join(dir, `failed-${name}`)).catch(() => {});
      log(`memory: unreadable journal ${name}`);
      continue;
    }
    if (typeof journal.file !== "string" || typeof journal.stateFile !== "string" || typeof journal.beforeHash !== "string" || typeof journal.after !== "string" || !journal.afterState || typeof journal.afterState !== "object") {
      await fs.rename(journalPath, path.join(dir, `failed-${name}`)).catch(() => {});
      log(`memory: invalid journal ${name}`);
      continue;
    }
    const target = path.resolve(journal.file);
    const stateTarget = path.resolve(journal.stateFile);
    if (!target.startsWith(rootPath + path.sep) || !stateTarget.startsWith(rootPath + path.sep)) {
      await fs.rename(journalPath, path.join(dir, `failed-${name}`)).catch(() => {});
      log(`memory: refused journal ${journal.opId}: target outside the memory folder`);
      continue;
    }
    const current = await readIfExists(journal.file);
    const currentHash = revisionOf(current);
    if (currentHash === journal.beforeHash) {
      await writeTextAtomic(journal.file, journal.after, 0o644);
      await writeMemoryStateFile(journal.stateFile, journal.afterState);
      await fs.rm(journalPath, { force: true });
      log(`memory: recovered ${journal.file} from journal ${journal.opId}`);
    } else if (currentHash === revisionOf(journal.after)) {
      await writeMemoryStateFile(journal.stateFile, journal.afterState);
      await fs.rm(journalPath, { force: true });
      log(`memory: completed state for ${journal.file} from journal ${journal.opId}`);
    } else {
      await fs.rename(journalPath, path.join(dir, `failed-${name}`)).catch(() => {});
      log(`memory: refused journal ${journal.opId}: ${journal.file} changed outside the core`);
    }
  }
}

/** Resume interrupted writes before the gateway reads a snapshot. A conflict is kept for review. */
export async function recoverMemoryJournals(botDir: string, sharedFile: string, log: (line: string) => void = () => {}): Promise<void> {
  const botCtx = memoryFileContext(botDir, sharedFile, "bot");
  const sharedCtx = memoryFileContext(botDir, sharedFile, "shared");
  await recoverJournalDir(botCtx.journalDir, path.join(botDir, "memory"), log);
  await recoverJournalDir(sharedCtx.journalDir, path.dirname(sharedFile), log);
}

/** Read one memory file in full, bounded, with the revision CAS uses. */
export async function readMemoryText({ botDir, sharedFile, scope, limits = {} }: { botDir: string; sharedFile: string; scope: MemoryScope; limits?: Partial<MemoryLimits> }): Promise<{ text: string; revision: string; truncated: boolean }> {
  const ctx = memoryFileContext(botDir, sharedFile, scope);
  const raw = await readIfExists(ctx.file);
  const max = scope === "bot" ? { ...MEMORY_LIMITS, ...limits }.memoryChars : { ...MEMORY_LIMITS, ...limits }.memoryChars;
  const text = raw.length > max ? `${raw.slice(0, max).trimEnd()}\n\n(truncated; read the file on disk for the rest)` : raw;
  return { text, revision: revisionOf(raw), truncated: raw.length > max };
}

/** Read a note and its revision, so a note write can compare-and-swap too. */
export async function readMemoryNoteWithRevision(botDir: string, notePath: string, limits: Partial<MemoryLimits> = {}): Promise<{ path: string; text: string; revision: string }> {
  const merged = { ...MEMORY_LIMITS, ...limits };
  const normalized = normalizeNotePath(notePath);
  const notesRoot = path.join(botDir, "memory", "notes");
  const absolute = path.resolve(botDir, normalized);
  const rootReal = await fs.realpath(notesRoot).catch(() => null);
  const fileReal = await fs.realpath(absolute).catch(() => null);
  if (!rootReal || !fileReal || (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep))) {
    throw Object.assign(new Error("That note is outside this Bot's memory"), { status: 403 });
  }
  const full = await fs.readFile(fileReal, "utf8");
  const text = full.length <= merged.noteChars ? full : `${full.slice(0, merged.noteChars).trimEnd()}\n\n(truncated; read the note on disk for the rest)`;
  return { path: normalized, text, revision: revisionOf(full) };
}

async function writeNote(input: MemoryMutationInput, ctx: MemoryFileContext, now: Date): Promise<MemoryMutationResult> {
  let normalized: string;
  try {
    normalized = normalizeNotePath(String(input.path ?? ""));
  } catch (error) {
    return { ok: false, code: "path", message: String((error as Error).message) };
  }
  const description = String(input.description ?? "").replace(/[\r\n]+/gu, " ").trim();
  if (!description || description.length > 160) return { ok: false, code: "invalid", message: "Pass a description of 1 to 160 characters." };
  const descriptionCheck = checkFact(description);
  if (!descriptionCheck.ok) return { ok: false, code: "invalid", message: `description: ${descriptionCheck.message}` };
  const body = String(input.content ?? "");
  if (!body.trim()) return { ok: false, code: "invalid", message: "Pass the note content." };
  const notesRoot = path.join(input.botDir, "memory", "notes");
  const absolute = path.resolve(input.botDir, normalized);
  if (!absolute.startsWith(notesRoot + path.sep)) return { ok: false, code: "path", message: "That note is outside this Bot's memory." };
  await fs.mkdir(notesRoot, { recursive: true });
  const botReal = await fs.realpath(input.botDir).catch(() => null);
  const rootReal = await fs.realpath(notesRoot).catch(() => null);
  const expectedRoot = botReal ? path.join(botReal, "memory", "notes") : null;
  if (!botReal || !rootReal || !expectedRoot || (rootReal !== expectedRoot && !rootReal.startsWith(expectedRoot + path.sep))) {
    return { ok: false, code: "path", message: "That note is outside this Bot's memory." };
  }
  let existingParent = path.dirname(absolute);
  while (!(await fs.stat(existingParent).catch(() => null))) existingParent = path.dirname(existingParent);
  const parentReal = await fs.realpath(existingParent).catch(() => null);
  if (!parentReal || (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep))) {
    return { ok: false, code: "path", message: "That note is outside this Bot's memory." };
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const existing = await readIfExists(absolute);
  const revision = revisionOf(existing);
  if (!existing) {
    const notes = await listMemoryNotes(input.botDir);
    if (notes.length >= MEMORY_LIMITS.noteCount) return { ok: false, code: "cap", message: `This Bot already has ${MEMORY_LIMITS.noteCount} notes. Merge or remove one first.` };
  }
  // A new note has no revision to read yet; "" means "create it".
  if (revision !== input.expectedRevision && !(existing === "" && input.expectedRevision === "")) {
    return { ok: false, code: "conflict", message: "The note changed since you read it. Read it again and merge.", revision, content: existing };
  }
  const withFrontmatter = body.startsWith("---") ? body : `${noteFrontmatter(description, path.basename(normalized, ".md"))}${body}`;
  const checked = checkNoteContent(withFrontmatter);
  if (!checked.ok) return { ok: false, code: "invalid", message: checked.message };
  const noteCtx: MemoryFileContext = { ...ctx, file: absolute, relative: normalized, label: `note-${path.basename(normalized, ".md")}` };
  const state = await readMemoryStateFile(ctx.stateFile);
  const nextState: MemoryState = {
    ...state,
    revisions: { ...state.revisions, [normalized]: revisionOf(withFrontmatter) },
    provenance: {
      ...state.provenance,
      [`note:${normalized}`]: { author: input.author, sourceMessageId: input.sourceMessageId, quote: input.sourceQuote, at: now.toISOString() },
    },
  };
  await writeHistory(noteCtx, existing, now);
  const opId = await writeJournal(noteCtx, existing, withFrontmatter, state, nextState, now);
  try {
    await writeTextAtomic(absolute, withFrontmatter, 0o644);
    await writeMemoryStateFile(ctx.stateFile, nextState);
  } finally {
    await fs.rm(path.join(ctx.journalDir, `${opId}.json`), { force: true }).catch(() => {});
  }
  return { ok: true, scope: input.scope, path: normalized, revision: revisionOf(withFrontmatter), note: withFrontmatter };
}

// One writer at a time per memory store (a Bot's own, or the shared one). The revision check and
// the write it guards are several awaits apart, so without this two callers holding the same
// revision both pass the check and the second silently replaces the first one's change.
const memoryWriters = new Map<string, Promise<void>>();

async function oneWriter<T>(store: string, work: () => Promise<T>): Promise<T> {
  const run = (memoryWriters.get(store) ?? Promise.resolve()).then(work);
  const settled = run.then(() => {}, () => {});
  memoryWriters.set(store, settled);
  try {
    return await run;
  } finally {
    if (memoryWriters.get(store) === settled) memoryWriters.delete(store);
  }
}

/**
 * One transactional mutation of `MEMORY.md`, the shared file or one note. The caller has already
 * resolved the authenticated Bot; this function still verifies the quote and the revision.
 * Mutations of the same store run one after another, so a stale revision always gets a conflict.
 */
export function mutateMemory(input: MemoryMutationInput): Promise<MemoryMutationResult> {
  const store = path.resolve(memoryFileContext(input.botDir, input.sharedFile, input.scope).stateFile);
  return oneWriter(store, () => applyMutation(input));
}

const FORGOTTEN: MemoryMutationResult = { ok: false, code: "forgotten", message: "The user forgot that fact. Only a new, explicit request from the user can bring it back; pass restore: true for that request." };

async function applyMutation(input: MemoryMutationInput): Promise<MemoryMutationResult> {
  const now = input.now ?? new Date();
  if (!input.trustedUser) {
    const evidence = checkOwnerEvidence(input.sourceText, input.sourceQuote);
    if (!evidence.ok) return { ok: false, code: "invalid", message: evidence.message };
  } else if (input.author !== "user") {
    return { ok: false, code: "invalid", message: "A trusted memory action must be made by the user." };
  }
  if (typeof input.expectedRevision !== "string") return { ok: false, code: "invalid", message: "expectedRevision is required. Read the memory first." };
  if (!input.author.trim()) return { ok: false, code: "invalid", message: "A memory write needs an author." };
  const ctx = memoryFileContext(input.botDir, input.sharedFile, input.scope);
  const category = input.category == null ? null : String(input.category).trim().toLowerCase();
  if (category && !/^[a-z][a-z0-9_-]{0,32}$/u.test(category)) {
    return { ok: false, code: "invalid", message: "category must be a short lowercase label (letters, digits, - or _)." };
  }
  if (input.op === "note" && input.scope === "shared") return { ok: false, code: "unsupported", message: "Notes live in a Bot's memory, not in shared memory." };
  if (input.op === "note") return writeNote(input, ctx, now);

  const current = await readIfExists(ctx.file);
  const revision = revisionOf(current);
  if (revision !== input.expectedRevision) {
    return { ok: false, code: "conflict", message: "Memory changed since you read it. Read it again, merge, and retry with the new revision.", revision, content: current };
  }
  const state = await readMemoryStateFile(ctx.stateFile);
  const { lines, trailing } = factLines(current);
  let nextLines = [...lines];
  let writtenLine: string | undefined;
  let forgotten: string | undefined;
  const temporal = { ...state.temporal };
  const provenance = { ...state.provenance };
  const forgottenHashes = new Set(state.forgotten);

  if (input.op === "add") {
    const fact = String(input.fact ?? "").trim();
    const checked = checkFact(fact);
    if (!checked.ok) return { ok: false, code: "invalid", message: checked.message };
    if (input.validFrom && !isDate(input.validFrom)) return { ok: false, code: "invalid", message: "validFrom must be a real YYYY-MM-DD date." };
    const key = hashFact(fact);
    if (forgottenHashes.has(key) && !input.restore) return FORGOTTEN;
    forgottenHashes.delete(key);
    if (nextLines.some((line) => line.trim() && factKey(line) === key)) return { ok: false, code: "duplicate", message: "That fact is already in memory." };
    const line = formatFact(fact, { category: category ?? null, source: sourceLabel(input.sourceMessageId, now), validFrom: input.validFrom ?? null });
    if (nextLines.filter((line) => line.trim()).length >= MEMORY_LIMITS.memoryLines || current.length + line.length + 1 > MEMORY_LIMITS.memoryChars) {
      return { ok: false, code: "cap", message: "This memory is full. Move detail into a note or wait for defrag." };
    }
    nextLines.push(line);
    writtenLine = line;
    provenance[key] = { author: input.author, sourceMessageId: input.sourceMessageId, quote: input.sourceQuote, at: now.toISOString() };
    if (input.validFrom) temporal[key] = { from: input.validFrom, to: null };
  } else if (input.op === "replace" || input.op === "supersede") {
    const found = findFactLine(nextLines, input.old);
    if ("error" in found) return found.error;
    const oldLine = nextLines[found.index]!;
    const fact = String(input.new ?? "").trim();
    const checked = checkFact(fact);
    if (!checked.ok) return { ok: false, code: "invalid", message: checked.message };
    // A forgotten fact must not come back as the new text of another one either.
    if (forgottenHashes.has(hashFact(fact)) && !input.restore) return FORGOTTEN;
    forgottenHashes.delete(hashFact(fact));
    const oldParsed = parseFact(oldLine);
    const validFrom = input.validFrom ?? (input.op === "supersede" ? localDate(now) : oldParsed.validFrom);
    if (input.op === "supersede" && !validFrom) return { ok: false, code: "invalid", message: "A superseding fact needs a validFrom date." };
    if (validFrom && !isDate(validFrom)) return { ok: false, code: "invalid", message: "validFrom must be a real YYYY-MM-DD date." };
    const line = formatFact(fact, { category: category ?? oldParsed.category, source: sourceLabel(input.sourceMessageId, now), validFrom });
    if (input.op === "supersede") {
      const closed = closeFactRange(oldLine, validFrom!);
      nextLines.splice(found.index, 1, closed, line);
      temporal[factKey(oldLine)] = { from: oldParsed.validFrom, to: validFrom! };
      temporal[hashFact(fact)] = { from: validFrom!, to: null };
    } else {
      nextLines[found.index] = line;
    }
    writtenLine = line;
    provenance[hashFact(fact)] = { author: input.author, sourceMessageId: input.sourceMessageId, quote: input.sourceQuote, at: now.toISOString() };
  } else if (input.op === "forget") {
    const found = findFactLine(nextLines, input.fact ?? input.old);
    if ("error" in found) return found.error;
    const oldLine = nextLines[found.index]!;
    const key = factKey(oldLine);
    nextLines.splice(found.index, 1);
    forgottenHashes.add(key);
    forgotten = key;
  } else {
    return { ok: false, code: "unsupported", message: `Unknown memory operation ${input.op}.` };
  }

  const next = joinLines(nextLines, trailing || nextLines.length > lines.length);
  if (nextLines.filter((line) => line.trim()).length > MEMORY_LIMITS.memoryLines) {
    return { ok: false, code: "cap", message: "This memory is over its line limit. Move detail into a note or wait for defrag." };
  }
  if (next.length > MEMORY_LIMITS.memoryChars) {
    return { ok: false, code: "cap", message: "This memory is over its size limit. Move detail into a note or wait for defrag." };
  }
  const nextState: MemoryState = {
    ...state,
    revisions: { ...state.revisions, [ctx.relative]: revisionOf(next) },
    provenance,
    forgotten: [...forgottenHashes],
    temporal,
  };
  await writeHistory(ctx, current, now);
  const opId = await writeJournal(ctx, current, next, state, nextState, now);
  try {
    await writeTextAtomic(ctx.file, next, 0o644);
    await writeMemoryStateFile(ctx.stateFile, nextState);
  } finally {
    await fs.rm(path.join(ctx.journalDir, `${opId}.json`), { force: true }).catch(() => {});
  }
  return { ok: true, scope: input.scope, path: ctx.relative, revision: revisionOf(next), ...(writtenLine ? { line: writtenLine } : {}), ...(forgotten ? { forgotten } : {}) };
}

export type MemoryDedupeResult =
  | { ok: true; removed: number; revision: string; path: string }
  | { ok: false; code: "conflict" | "invalid"; message: string; revision?: string; content?: string };

/** Remove only byte-identical duplicate fact lines. Lossless; no tombstone and no fact rewrite. */
export async function dedupeExactFacts({ botDir, sharedFile, scope, expectedRevision, now = new Date() }: {
  botDir: string; sharedFile: string; scope: MemoryScope; expectedRevision: string; now?: Date;
}): Promise<MemoryDedupeResult> {
  const ctx = memoryFileContext(botDir, sharedFile, scope);
  const current = await readIfExists(ctx.file);
  const revision = revisionOf(current);
  if (revision !== expectedRevision) return { ok: false, code: "conflict", message: "Memory changed since the audit. Read it again.", revision, content: current };
  const { lines, trailing } = factLines(current);
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (/^\s*[-*+]\s+/u.test(line)) {
      const key = line.trim();
      if (seen.has(key)) { removed += 1; continue; }
      seen.add(key);
    }
    kept.push(line);
  }
  if (removed === 0) return { ok: true, removed: 0, revision, path: ctx.relative };
  const next = joinLines(kept, trailing);
  const state = await readMemoryStateFile(ctx.stateFile);
  const nextState: MemoryState = { ...state, revisions: { ...state.revisions, [ctx.relative]: revisionOf(next) } };
  await writeHistory(ctx, current, now);
  const opId = await writeJournal(ctx, current, next, state, nextState, now);
  try {
    await writeTextAtomic(ctx.file, next, 0o644);
    await writeMemoryStateFile(ctx.stateFile, nextState);
  } finally {
    await fs.rm(path.join(ctx.journalDir, `${opId}.json`), { force: true }).catch(() => {});
  }
  return { ok: true, removed, revision: revisionOf(next), path: ctx.relative };
}

/** Close an existing fact's date range without inventing a start date. */
export function closeFactRange(line: string, to: string): string {
  const sourceMatch = /\s*\[source:\s*[^\]]+\]\s*$/iu.exec(line);
  const source = sourceMatch?.[0] ?? "";
  let body = source ? line.slice(0, sourceMatch!.index) : line;
  const temporal = new RegExp(`@(effective|occurred|due|valid|mentioned)(?::(${DATE})|\\[(${DATE})?,(${DATE})?\\))`, "iu").exec(body);
  if (temporal) {
    const from = temporal[2] ?? temporal[3] ?? "";
    body = body.replace(temporal[0], `@${temporal[1]}[${from},${to})`);
  } else {
    const prefix = /^\s*[-*+]\s+(?:\[[a-z][a-z0-9_-]{0,32}\]\s*)?/iu.exec(body);
    const at = prefix?.[0].length ?? 0;
    body = `${body.slice(0, at)}@valid[,${to}) ${body.slice(at)}`;
  }
  return `${body}${source}`;
}

export type MemorySearchHit = { scope: MemoryScope; path: string; line: number; text: string; score: number; source: string | null };

/** Plain text search over `MEMORY.md`, shared memory and notes. Rebuildable; no index required. */
export async function searchMemory({ botDir, sharedFile, query, limit = 20 }: { botDir: string; sharedFile: string; query: string; limit?: number }): Promise<MemorySearchHit[]> {
  const terms = evidenceText(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const phrase = terms.join(" ");
  const files: { scope: MemoryScope; path: string; text: string }[] = [];
  const botText = await readIfExists(path.join(botDir, "memory", "MEMORY.md"));
  const sharedText = await readIfExists(sharedFile);
  if (botText) files.push({ scope: "bot", path: "MEMORY.md", text: botText });
  if (sharedText) files.push({ scope: "shared", path: "shared-memory.md", text: sharedText });
  for (const note of await listMemoryNotes(botDir)) {
    files.push({ scope: "bot", path: note.path, text: await readIfExists(path.join(botDir, note.path)) });
  }
  const hits: MemorySearchHit[] = [];
  for (const file of files) {
    const lines = normalizeText(file.text).split("\n");
    for (const [index, raw] of lines.entries()) {
      if (!raw.trim()) continue;
      const text = evidenceText(raw);
      const exact = text.includes(phrase);
      const all = terms.every((term) => text.includes(term));
      const any = terms.some((term) => text.includes(term));
      if (!exact && !all && !any) continue;
      const parsed = parseFact(raw);
      hits.push({ scope: file.scope, path: file.path, line: index + 1, text: raw.trim(), score: exact ? 10 : all ? 5 : 2, source: parsed.source });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, Math.max(1, limit));
}
