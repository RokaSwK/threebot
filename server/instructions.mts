// A Bot's standing instructions are the part of `AGENTS.md` after the managed block.
// Threebot owns the managed block; the owner owns the rest. This module reads and writes
// that part with a revision check, so neither side replaces the other's text silently.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MANAGED_END, MANAGED_START, replaceCustom, splitManaged } from "./bot-template.mts";
import { withFileLock } from "./file-lock.mts";
import { writeTextAtomic } from "./memory.mts";

/** What the Instructions tab may write, and when it warns. */
export const INSTRUCTION_LIMITS = Object.freeze({
  // The owner's part is prose, not a dump of the repository. This is far past a job description.
  customChars: 12_000,
  // Some harnesses cut a very long project file. The managed block is already 17–19 KB.
  warnTotalBytes: 24_000,
  maxTotalBytes: 32_000,
});

export type InstructionFile = {
  path: string;
  text: string;
  revision: string;
  /** Bytes of the owner's part. */
  bytes: number;
  /** Bytes of the whole `AGENTS.md`. */
  totalBytes: number;
  maxChars: number;
  warnAt: number;
  /** The whole file's hard limit; the tab disables Save before the server has to reject it. */
  maxTotalBytes: number;
  /** False when the file has no managed block yet; the gateway repairs it before reading. */
  managed: boolean;
};

export type InstructionSaveResult =
  | { ok: true; revision: string; bytes: number; totalBytes: number }
  | { ok: false; code: "conflict"; message: string; revision: string; text: string }
  | { ok: false; code: "invalid"; message: string };

const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
const revisionOf = (content: string) => createHash("sha256").update(normalize(content)).digest("hex");

/** The custom text's limit, shared by the tab, creation and helper-Bot seeds. */
export function instructionTextError(text: string): string | null {
  return text.length > INSTRUCTION_LIMITS.customChars
    ? `Instructions are limited to ${INSTRUCTION_LIMITS.customChars.toLocaleString("en-US")} characters.`
    : null;
}

/** The whole file's limit, measured after the managed block and the owner's text are joined. */
export function instructionTotalError(totalBytes: number): string | null {
  return totalBytes > INSTRUCTION_LIMITS.maxTotalBytes
    ? `The file would be ${totalBytes.toLocaleString("en-US")} bytes; the limit is ${INSTRUCTION_LIMITS.maxTotalBytes.toLocaleString("en-US")}. Shorten the instructions.`
    : null;
}

/** The owner's text is plain prose. It can't close the managed block or the memory element. */
export function sanitizeInstructions(value: string): string {
  return normalize(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replaceAll(MANAGED_START, "[managed marker removed]")
    .replaceAll(MANAGED_END, "[managed marker removed]")
    .replaceAll("<memory>", "&lt;memory&gt;")
    .replaceAll("</memory>", "&lt;/memory&gt;");
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** The owner's text without the blank lines that separate it from the managed block. */
function customText(existing: string): { managed: boolean; text: string } {
  const parts = splitManaged(existing);
  if (!parts) return { managed: false, text: "" };
  return { managed: true, text: parts.custom.replace(/^\n+/u, "") };
}

/**
 * Where a Bot keeps its standing instructions.
 * - A Bot in its own folder: the text after the managed block in its `AGENTS.md` (the "free zone").
 * - A Bot made from a project: `.bot/INSTRUCTIONS.md`, which the gateway copies into the managed
 *   block of `CLAUDE.local.md` and `AGENTS.override.md`. The text after those blocks is the user's
 *   own file content from before adoption, so this tab never writes there.
 */
export type InstructionsTarget =
  | { kind: "agents"; botDir: string }
  | { kind: "adopted"; botDir: string; renderedFiles: string[] };

export const ADOPTED_INSTRUCTIONS = "INSTRUCTIONS.md";

const targetFile = (target: InstructionsTarget) => path.join(target.botDir, target.kind === "agents" ? "AGENTS.md" : ADOPTED_INSTRUCTIONS);

/** An adopted Bot's instructions, sanitized, for the managed block. Empty when there are none. */
export async function readAdoptedInstructions(botDir: string): Promise<string> {
  return sanitizeInstructions(await readIfExists(path.join(botDir, ADOPTED_INSTRUCTIONS))).trim();
}

/** The largest file the instructions end up in, so the tab can warn before a harness cuts it. */
async function renderedBytes(target: InstructionsTarget, existing: string): Promise<number> {
  if (target.kind === "agents") return Buffer.byteLength(existing, "utf8");
  const sizes = await Promise.all(target.renderedFiles.map(async (file) => Buffer.byteLength(await readIfExists(file), "utf8")));
  return Math.max(0, ...sizes);
}

async function current(target: InstructionsTarget) {
  const existing = await readIfExists(targetFile(target));
  if (target.kind === "agents") return { existing, ...customText(existing) };
  return { existing, managed: true, text: normalize(existing) };
}

/** What the Instructions tab loads: the owner's text, its revision, and the file's size. */
export async function readInstructions(target: InstructionsTarget): Promise<InstructionFile> {
  const { existing, managed, text } = await current(target);
  return {
    path: target.kind === "agents" ? "AGENTS.md" : `.bot/${ADOPTED_INSTRUCTIONS}`,
    text,
    revision: revisionOf(text),
    bytes: Buffer.byteLength(text, "utf8"),
    totalBytes: await renderedBytes(target, existing),
    maxChars: INSTRUCTION_LIMITS.customChars,
    warnAt: INSTRUCTION_LIMITS.warnTotalBytes,
    maxTotalBytes: INSTRUCTION_LIMITS.maxTotalBytes,
    managed,
  };
}

/**
 * Save the Instructions tab's text. The save only goes through if the owner's text still has
 * the revision the tab loaded; otherwise the Bot (or another tab) changed it, and the caller
 * gets the current text. A managed block is read from disk at save time and left untouched.
 */
export function saveInstructions(target: InstructionsTarget, { text, expectedRevision }: {
  text: unknown; expectedRevision: unknown;
}): Promise<InstructionSaveResult> {
  if (typeof text !== "string" || typeof expectedRevision !== "string") {
    return Promise.resolve({ ok: false, code: "invalid", message: "text and expectedRevision are required" });
  }
  const textError = instructionTextError(text);
  if (textError) return Promise.resolve({ ok: false, code: "invalid", message: textError });
  const file = targetFile(target);
  return withFileLock(file, async () => {
    const { existing, managed, text: before } = await current(target);
    if (!managed) return { ok: false, code: "invalid", message: "The Bot's instructions file is missing its managed block. Reload the tab." };
    if (revisionOf(before) !== expectedRevision) {
      return { ok: false, code: "conflict", message: "The instructions changed since you opened them.", revision: revisionOf(before), text: before };
    }
    const next = sanitizeInstructions(text).trim();
    const content = target.kind === "agents" ? replaceCustom(existing, next) : next ? `${next}\n` : "";
    // An adopted Bot's text lands inside other files; estimate the largest one after the change.
    const totalBytes = target.kind === "agents"
      ? Buffer.byteLength(content, "utf8")
      : await renderedBytes(target, existing) - Buffer.byteLength(before, "utf8") + Buffer.byteLength(content, "utf8");
    const totalError = instructionTotalError(totalBytes);
    if (totalError) return { ok: false, code: "invalid", message: totalError };
    // Keep the temp-and-rename write, so a reader never sees half a file.
    await writeTextAtomic(file, content);
    // Return what is actually on disk: the separator and trailing newline are added here, and a
    // revision that disagreed with the next read would turn the next save into a false 409.
    const saved = target.kind === "agents" ? customText(content).text : content;
    return {
      ok: true,
      revision: revisionOf(saved),
      bytes: Buffer.byteLength(saved, "utf8"),
      totalBytes,
    };
  });
}
