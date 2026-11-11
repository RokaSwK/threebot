// A Bot's memory is plain Markdown: `memory/MEMORY.md` in the Bot's folder, plus
// `.botapp/shared-memory.md` for what every Bot should know. The Bot edits these files like any
// other file, and the user edits them in the Memory tab.
//
// The gateway copies a bounded snapshot of both files into the Bot's `AGENTS.md`, so a fresh
// session starts knowing what is in them without reading anything.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** How much of each file goes into `AGENTS.md`. The files themselves can be longer. */
export const MEMORY_LIMITS = Object.freeze({
  // The snapshot is paid for in every session, so it stays bounded.
  snapshotBotLines: 200,
  snapshotBotChars: 8_000,
  snapshotSharedLines: 60,
  snapshotSharedChars: 2_500,
  // A save from the Memory tab larger than this is refused; it is far past what a snapshot carries.
  fileChars: 200_000,
});

export type MemoryLimits = { -readonly [K in keyof typeof MEMORY_LIMITS]: number };
export type MemoryScope = "bot" | "shared";

/** What the gateway reads to render `AGENTS.md`, and what the watcher compares between ticks. */
export type MemorySnapshot = {
  bot: string;
  shared: string;
  revision: string;
  sharedRevision: string;
  truncated: { bot: boolean; shared: boolean };
};

/** One memory file as the Memory tab sees it. */
export type MemoryFile = { path: string; text: string; revision: string };

export type MemorySaveResult =
  | { ok: true; revision: string }
  | { ok: false; code: "conflict"; message: string; revision: string; text: string }
  | { ok: false; code: "invalid"; message: string };

const MANAGED_START = "<!-- bot:managed:start -->";
const MANAGED_END = "<!-- bot:managed:end -->";

export function memoryFilePath(botDir: string, sharedFile: string, scope: MemoryScope): string {
  return scope === "shared" ? sharedFile : path.join(botDir, "memory", "MEMORY.md");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** The revision a save must send back, so it never silently replaces a newer edit. */
export function revisionOf(content: string): string {
  return createHash("sha256").update(normalizeText(content)).digest("hex");
}

// The snapshot is pasted inside AGENTS.md's managed block and a `<memory>` element, so the file
// can't close either of them early.
function sanitizeMemoryText(value: string): string {
  return normalizeText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replaceAll(MANAGED_START, "[managed marker removed]")
    .replaceAll(MANAGED_END, "[managed marker removed]")
    .replaceAll("<memory>", "&lt;memory&gt;")
    .replaceAll("</memory>", "&lt;/memory&gt;");
}

function clipSnapshot(value: string, maxLines: number, maxChars: number, file: string): { text: string; truncated: boolean } {
  const lines = normalizeText(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  // The file's own title is already implied by the snapshot's headings.
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
  if (truncated) kept.push(`(cut short here; read ${file} for the rest, and tidy it so it fits)`);
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

/** Read both files, bounded for the prompt. */
export async function readSnapshot({ botDir, sharedFile, limits = {} }: { botDir: string; sharedFile: string; limits?: Partial<MemoryLimits> }): Promise<MemorySnapshot> {
  const merged = { ...MEMORY_LIMITS, ...limits };
  const [botRaw, sharedRaw] = await Promise.all([readIfExists(memoryFilePath(botDir, sharedFile, "bot")), readIfExists(sharedFile)]);
  const bot = clipSnapshot(sanitizeMemoryText(botRaw), merged.snapshotBotLines, merged.snapshotBotChars, "memory/MEMORY.md");
  const shared = clipSnapshot(sanitizeMemoryText(sharedRaw), merged.snapshotSharedLines, merged.snapshotSharedChars, "the shared memory file");
  return {
    bot: bot.text,
    shared: shared.text,
    revision: revisionOf(botRaw),
    sharedRevision: revisionOf(sharedRaw),
    truncated: { bot: bot.truncated, shared: shared.truncated },
  };
}

/** The `<memory>` block inside `AGENTS.md`. Memory is data; the delimiters make that explicit. */
export function renderMemoryBlock(snapshot: MemorySnapshot): string {
  if (!snapshot.shared.trim() && !snapshot.bot.trim()) return "";
  return [
    "<memory>",
    "### Shared by all Bots",
    snapshot.shared.trim() || "- (nothing saved yet)",
    "",
    "### This Bot (memory/MEMORY.md)",
    snapshot.bot.trim() || "- (nothing saved yet)",
    "</memory>",
  ].join("\n");
}

/** A stable key for a snapshot, so the watcher writes `AGENTS.md` only when something changed. */
export function memorySignature(snapshot: MemorySnapshot): string {
  return `${snapshot.revision}|${snapshot.sharedRevision}`;
}

/** Both files for the Memory tab, whole. */
/** `botPath` is how the Memory tab names the Bot's file: inside its folder, `.bot/` for a Bot made from a project. */
export async function readMemoryFiles({ botDir, sharedFile, botPath = "memory/MEMORY.md" }: { botDir: string; sharedFile: string; botPath?: string }): Promise<{ bot: MemoryFile; shared: MemoryFile }> {
  const [bot, shared] = await Promise.all([readIfExists(memoryFilePath(botDir, sharedFile, "bot")), readIfExists(sharedFile)]);
  return {
    bot: { path: botPath, text: bot, revision: revisionOf(bot) },
    shared: { path: ".botapp/shared-memory.md", text: shared, revision: revisionOf(shared) },
  };
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

const writers = new Map<string, Promise<void>>();

// Saves to one file run one at a time, so two saves holding the same revision can't both pass.
async function oneWriter<T>(file: string, work: () => Promise<T>): Promise<T> {
  const run = (writers.get(file) ?? Promise.resolve()).then(work);
  const settled = run.then(() => {}, () => {});
  writers.set(file, settled);
  try {
    return await run;
  } finally {
    if (writers.get(file) === settled) writers.delete(file);
  }
}

/**
 * Save the Memory tab's text. The save only goes through if the file still has the revision the
 * tab loaded; otherwise the Bot (or another tab) changed it, and the caller gets the current text.
 */
export function saveMemoryFile({ botDir, sharedFile, scope, text, expectedRevision }: { botDir: string; sharedFile: string; scope: MemoryScope; text: unknown; expectedRevision: unknown }): Promise<MemorySaveResult> {
  if (typeof text !== "string" || typeof expectedRevision !== "string") return Promise.resolve({ ok: false, code: "invalid", message: "text and expectedRevision are required" });
  if (text.length > MEMORY_LIMITS.fileChars) return Promise.resolve({ ok: false, code: "invalid", message: `Memory is limited to ${MEMORY_LIMITS.fileChars.toLocaleString("en-US")} characters.` });
  const file = memoryFilePath(botDir, sharedFile, scope);
  return oneWriter(file, async () => {
    const current = await readIfExists(file);
    const revision = revisionOf(current);
    if (revision !== expectedRevision) return { ok: false, code: "conflict", message: "Memory changed since you opened it.", revision, text: current };
    const next = normalizeText(text);
    await writeTextAtomic(file, next.endsWith("\n") || next === "" ? next : `${next}\n`);
    return { ok: true, revision: revisionOf(await readIfExists(file)) };
  });
}
