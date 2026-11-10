// The memory tools on the Bots' own MCP server ("bot"). They are thin adapters over
// server/memory.mts: identity comes from the per-Bot bearer, the source message comes from T3,
// and the core decides whether a write is allowed.
import path from "node:path";
import {
  MEMORY_LIMITS,
  checkOwnerEvidence,
  listMemoryNotes,
  appendDream,
  mutateMemory,
  readMemoryNoteWithRevision,
  readMemoryState,
  writeReflectionBookmark,
  readMemoryText,
  searchMemory,
  splitMemoryNote,
  mergeMemoryNotes,
  type MemoryNoteSource,
  type MemoryMessage,
  type MemoryScope,
} from "./memory.mts";
import { runDefragAudit, runRetireClosed, runSafeDedupe } from "./memory-defrag.mts";

export type { MemoryMessage } from "./memory.mts";

/** One message a Bot can use as evidence; only owner messages are ever returned by the gateway. */
export type MemoryMessageSource = {
  latestOwnerMessage(botSlug: string): Promise<MemoryMessage | null>;
  messageById(botSlug: string, messageId: string): Promise<MemoryMessage | null>;
  /** Reflection reads the owner's messages after the bookmark, not just the latest one. */
  reflectMessages?: (botSlug: string, afterPosition: number, limit: number) => Promise<{ messages: ReflectedMessage[]; nextPosition: number | null; lastMessageId: string | null }>;
  reflectMessageById?: (botSlug: string, messageId: string) => Promise<ReflectedMessage | null>;
};

/** An owner message with its transcript position, used by reflection. */
export type ReflectedMessage = MemoryMessage & { position: number; at: string | null };

/** The authenticated caller of the tool server. `legacy` is the old shared bearer. */
export type MemoryToolContext = { botSlug?: string | null; legacy?: boolean };
export type MemoryToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type MemoryTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

type ToolArgs = Record<string, unknown>;

const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." };
const threadIdHelp = "Your main conversation's T3 thread id (in AGENTS.md, or mainThreadId in .bot/bot.json).";
const scopeHelp = "bot (this Bot's memory, default) or shared (facts every Bot needs).";

export const MEMORY_TOOLS: MemoryTool[] = [
  {
    name: "memory_read",
    title: "Read memory",
    description:
      "Read this Bot's memory: MEMORY.md, the shared memory all Bots use, and the index of notes. Pass topic to read one note in full. Read memory before changing it so you have the current revision.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["bot", "shared", "all"], description: "What to read; default all." },
        topic: { type: "string", description: "A note path from the notes index, e.g. memory/notes/projects/threebot.md." },
        full: { type: "boolean", description: "Read the whole note instead of the session-sized preview." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_edit",
    title: "Save to memory",
    description:
      "Save one lasting fact, decision or preference to this Bot's memory or the shared memory, or write a note. Only the user's own typed words count as evidence: put the exact phrase in sourceQuote. Never save passwords, keys, tokens or identity numbers; use the Vault. expectedRevision must be the revision from memory_read (or empty string to create a new note). If memory changed, the tool returns a conflict with the current content; read it, merge and retry.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "replace", "supersede", "note"], description: "add a fact, replace an existing one, supersede it with a dated new one, or write a note." },
        fact: { type: "string", description: "The fact for add, one line, 200 characters or fewer." },
        old: { type: "string", description: "The exact existing line for replace or supersede." },
        new: { type: "string", description: "The new fact for replace or supersede." },
        category: { type: "string", description: "Optional: preference, decision, commitment, person, project, lesson, fact, risk, question." },
        validFrom: { ...date, description: "When this becomes true (YYYY-MM-DD); required for supersede, optional for add." },
        restore: { type: "boolean", description: "Only when the user explicitly asks to remember a fact they previously forgot; removes its tombstone." },
        path: { type: "string", description: "For note: under memory/notes and ending in .md." },
        description: { type: "string", description: "For note: 1-160 characters shown in the notes index." },
        content: { type: "string", description: "For note: the Markdown body. Frontmatter is added if missing." },
        scope: { type: "string", enum: ["bot", "shared"], description: scopeHelp },
        expectedRevision: { type: "string", description: "The revision from memory_read; empty string only when creating a new note." },
        sourceMessageId: { type: "string", description: "The T3 message id the quote came from; omit to use the user's latest message." },
        sourceQuote: { type: "string", description: "The user's exact typed phrase that supports the fact." },
        threadId: { type: "string", description: threadIdHelp },
      },
      required: ["op", "expectedRevision", "sourceQuote"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_note_split",
    title: "Split a note",
    description:
      "Split one note at its level-2 Markdown headings. The original becomes a small index linking the parts; every section survives in a new note. Read the note first and pass its current revision. This is mechanical, not a rewrite: it refuses fewer than two non-empty sections, conflicts, and notes that would exceed the note limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The note to split, e.g. memory/notes/projects/threebot.md." },
        expectedRevision: { type: "string", description: "The revision from memory_read topic." },
        targetDir: { type: "string", description: "Optional folder under memory/notes for the parts; defaults to a folder beside the note." },
        threadId: { type: "string", description: threadIdHelp },
      },
      required: ["path", "expectedRevision"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_note_merge",
    title: "Merge notes",
    description:
      "Merge two or more notes into one canonical note. The target may be new or existing; every source must be read first and pass its current revision. Raw source notes are copied to memory/notes/archive and each source becomes a redirect, so nothing is lost. Use this when notes clearly cover the same topic; do not merge notes merely because their descriptions are similar.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The canonical target note path." },
        expectedRevision: { type: "string", description: "The target's revision; empty string only when creating it." },
        sources: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              expectedRevision: { type: "string" },
            },
            required: ["path", "expectedRevision"],
          },
          description: "Notes to merge; they must be distinct from the target.",
        },
        description: { type: "string", description: "Optional description for the merged note." },
        threadId: { type: "string", description: threadIdHelp },
      },
      required: ["path", "expectedRevision", "sources"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_forget",
    title: "Forget a fact",
    description:
      "Remove one exact fact from memory when the user asks to forget it. This writes a tombstone so reflection cannot bring it back; it does not delete the T3 conversation. Pass the exact line and the user's request in sourceQuote.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The exact existing line to remove." },
        scope: { type: "string", enum: ["bot", "shared"], description: scopeHelp },
        expectedRevision: { type: "string", description: "The revision from memory_read." },
        sourceMessageId: { type: "string", description: "The T3 message id the request came from; omit for the latest message." },
        sourceQuote: { type: "string", description: "The user's exact words asking to forget it." },
        threadId: { type: "string", description: threadIdHelp },
      },
      required: ["fact", "expectedRevision", "sourceQuote"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_reflect",
    title: "Read new messages for reflection",
    description:
      "Read the user's owner-written messages after the last reflection bookmark, bounded. Use this only when asked to reflect or tidy memory: read the packet, then propose small add/replace/supersede operations to memory_reflect_apply. Do not use old messages as ordinary memory_edit evidence.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum messages to return; default 40, maximum 80." },
        threadId: { type: "string", description: threadIdHelp },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_reflect_apply",
    title: "Apply a reflection",
    description:
      "Apply a small set of operations proposed after memory_reflect. Each operation needs the exact sourceMessageId and a sourceQuote from that owner message. Maximum 10 operations; no forget and no note. Memory_reflect_apply audits every quote and revision, writes the bookmark only when the batch succeeds, and logs a DREAMS.md line. If a fact already exists it is skipped. Do not use this for ordinary chat-time memory edits.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          minItems: 0,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "replace", "supersede"] },
              fact: { type: "string", description: "For add." },
              old: { type: "string", description: "The exact existing line for replace or supersede." },
              new: { type: "string", description: "For replace or supersede." },
              category: { type: "string" },
              validFrom: { ...date },
              sourceMessageId: { type: "string" },
              sourceQuote: { type: "string" },
            },
            required: ["op", "sourceMessageId", "sourceQuote"],
          },
        },
        expectedRevision: { type: "string", description: "The revision from memory_reflect." },
        throughPosition: { type: "number", description: "The last position returned by memory_reflect." },
        lastMessageId: { type: "string", description: "The last message id returned by memory_reflect." },
      },
      required: ["operations", "expectedRevision", "throughPosition", "lastMessageId"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_defrag",
    title: "Audit and defrag memory",
    description:
      "Audit the whole memory store and write a proposed defrag plan. op audit is read-only for facts and writes only the plan note. op safe-dedupe removes byte-identical duplicate fact lines. op retire-closed moves facts whose explicit validity ended into memory/notes/history; the exact line and source survive. Destructive changes stay in the plan for the user.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["audit", "safe-dedupe", "retire-closed"], description: "audit (default), safe-dedupe, or retire-closed." },
        threadId: { type: "string", description: threadIdHelp },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_search",
    title: "Search memory",
    description:
      "Search MEMORY.md, shared memory and notes. Use it before answering questions about past preferences, decisions or project details that are not in the snapshot. Exact phrases score highest; returned paths can be read with memory_read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words or a phrase to find." },
        scope: { type: "string", enum: ["bot", "shared", "all"], description: "Where to search; default all." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
];

function toolJson(value: unknown): MemoryToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function toolError(text: string): MemoryToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function botDir(botsRoot: string, slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(slug)) throw new Error("Invalid Bot slug.");
  const root = path.resolve(botsRoot);
  const dir = path.resolve(root, slug);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error("That Bot is outside the Bots folder.");
  return dir;
}

function scopeOf(args: ToolArgs): MemoryScope {
  return args.scope === "shared" ? "shared" : "bot";
}

const GENERIC_ATTACHMENT_QUOTES = new Set([
  "look at this", "check this", "read this", "see this", "open this",
  "mira esto", "revisa esto", "lee esto", "mira este archivo", "revisa este archivo",
]);

function normalizedQuote(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function createMemoryTools({
  botsRoot,
  sharedFile,
  source,
  log = () => {},
}: {
  botsRoot: string;
  sharedFile: string;
  source: MemoryMessageSource;
  log?: (line: string) => void;
}) {
  async function requireBot(context: MemoryToolContext | undefined): Promise<string> {
    if (!context?.botSlug) {
      throw new Error("Memory tools need this Bot's own MCP token. Restart the session so the gateway can write .mcp.json; the shared legacy token cannot touch memory.");
    }
    if (context.legacy) {
      throw new Error("The shared legacy token cannot touch memory. Restart the session so the gateway writes this Bot's own token.");
    }
    return context.botSlug;
  }

  async function evidence(args: ToolArgs, slug: string) {
    const quote = String(args.sourceQuote ?? "").trim();
    if (!quote) throw new Error("Pass the user's exact words in sourceQuote.");
    const id = String(args.sourceMessageId ?? "").trim();
    const message = id ? await source.messageById(slug, id) : await source.latestOwnerMessage(slug);
    if (!message) {
      throw new Error(id
        ? "I couldn't find that message in this Bot's conversation. Use the message id from T3 or leave sourceMessageId out to use the latest user message."
        : "I couldn't find a user message to use as evidence. Ask the user to state the fact in their own words.");
    }
    const checked = checkOwnerEvidence(message.text, quote);
    if (!checked.ok) throw new Error(checked.message);
    if (message.attachments?.length && GENERIC_ATTACHMENT_QUOTES.has(normalizedQuote(quote))) {
      throw new Error("That message only points at an attachment. Quote the user's own sentence that states the fact, or ask them to type it.");
    }
    return { messageId: message.id, sourceQuote: quote, sourceText: message.text };
  }

  return async function callMemoryTool(name: string, args: ToolArgs = {}, context: MemoryToolContext = {}): Promise<MemoryToolResult> {
    try {
      const slug = await requireBot(context);
      const dir = botDir(botsRoot, slug);
      if (name === "memory_read") {
        if (typeof args.topic === "string" && args.topic.trim()) {
          const note = await readMemoryNoteWithRevision(dir, args.topic.trim(), args.full === true ? { noteChars: 100_000 } : {});
          return toolJson({ scope: "bot", topic: note.path, content: note.text, revision: note.revision, ...(args.full === true ? { full: true } : {}) });
        }
        const scope = args.scope === "bot" || args.scope === "shared" ? args.scope : "all";
        const bot = scope === "shared" ? null : await readMemoryText({ botDir: dir, sharedFile, scope: "bot" });
        const shared = scope === "bot" ? null : await readMemoryText({ botDir: dir, sharedFile, scope: "shared" });
        return toolJson({
          ...(bot ? { bot: bot.text, revision: bot.revision, ...(bot.truncated ? { botTruncated: true } : {}) } : {}),
          ...(shared ? { shared: shared.text, sharedRevision: shared.revision, ...(shared.truncated ? { sharedTruncated: true } : {}) } : {}),
          ...(scope !== "shared" ? { notes: await listMemoryNotes(dir) } : {}),
          limits: { memoryChars: MEMORY_LIMITS.memoryChars, factChars: MEMORY_LIMITS.factChars, noteChars: MEMORY_LIMITS.noteChars },
        });
      }

      if (name === "memory_edit") {
        const op = String(args.op ?? "");
        if (!["add", "replace", "supersede", "note"].includes(op)) return toolError("op must be add, replace, supersede or note.");
        if (typeof args.expectedRevision !== "string") return toolError("expectedRevision is required; read memory first (empty string only for a new note).");
        const found = await evidence(args, slug);
        const result = await mutateMemory({
          botDir: dir,
          sharedFile,
          scope: scopeOf(args),
          op: op as "add" | "replace" | "supersede" | "note",
          expectedRevision: args.expectedRevision,
          author: slug,
          sourceMessageId: found.messageId,
          sourceQuote: found.sourceQuote,
          sourceText: found.sourceText,
          fact: typeof args.fact === "string" ? args.fact : undefined,
          old: typeof args.old === "string" ? args.old : undefined,
          new: typeof args.new === "string" ? args.new : undefined,
          category: typeof args.category === "string" ? args.category : null,
          path: typeof args.path === "string" ? args.path : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          content: typeof args.content === "string" ? args.content : undefined,
          validFrom: typeof args.validFrom === "string" ? args.validFrom : null,
          restore: args.restore === true,
        });
        if (!result.ok) return toolError(JSON.stringify(result));
        log(`memory: ${slug} ${op} ${result.path}${result.scope === "shared" ? " (shared)" : ""}`);
        return toolJson(result);
      }

      if (name === "memory_note_split") {
        const pathValue = String(args.path ?? "").trim();
        if (!pathValue) return toolError("path is required.");
        if (typeof args.expectedRevision !== "string") return toolError("expectedRevision is required; read the note first.");
        const result = await splitMemoryNote({ botDir: dir, path: pathValue, expectedRevision: args.expectedRevision, targetDir: typeof args.targetDir === "string" ? args.targetDir : undefined });
        return toolJson(result);
      }
      if (name === "memory_note_merge") {
        const pathValue = String(args.path ?? "").trim();
        if (!pathValue) return toolError("path is required.");
        if (typeof args.expectedRevision !== "string") return toolError("expectedRevision is required; read the target note first.");
        if (!Array.isArray(args.sources) || args.sources.length < 2) return toolError("sources must list at least two notes.");
        const sources: MemoryNoteSource[] = [];
        for (const raw of args.sources) {
          const source = raw as Record<string, unknown>;
          if (typeof source.path !== "string" || typeof source.expectedRevision !== "string") return toolError("Every source needs path and expectedRevision.");
          sources.push({ path: source.path, expectedRevision: source.expectedRevision });
        }
        const result = await mergeMemoryNotes({ botDir: dir, targetPath: pathValue, expectedRevision: args.expectedRevision, sources, description: typeof args.description === "string" ? args.description : undefined });
        return toolJson(result);
      }

      if (name === "memory_forget") {
        if (typeof args.expectedRevision !== "string") return toolError("expectedRevision is required; read memory first.");
        const found = await evidence(args, slug);
        const result = await mutateMemory({
          botDir: dir,
          sharedFile,
          scope: scopeOf(args),
          op: "forget",
          expectedRevision: args.expectedRevision,
          author: slug,
          sourceMessageId: found.messageId,
          sourceQuote: found.sourceQuote,
          sourceText: found.sourceText,
          fact: typeof args.fact === "string" ? args.fact : undefined,
        });
        if (!result.ok) return toolError(JSON.stringify(result));
        log(`memory: ${slug} forgot one fact`);
        return toolJson(result);
      }

      if (name === "memory_reflect") {
        if (!source.reflectMessages) return toolError("Reflection isn't set up on this gateway.");
        const state = await readMemoryState(dir);
        const after = state.reflection.lastPosition ?? -1;
        const limit = Math.max(1, Math.min(80, Number(args.limit) || 40));
        const packet = await source.reflectMessages(slug, after, limit);
        const current = await readMemoryText({ botDir: dir, sharedFile, scope: "bot" });
        return toolJson({
          messages: packet.messages,
          nextPosition: packet.nextPosition,
          lastMessageId: packet.lastMessageId,
          revision: current.revision,
          bookmark: state.reflection,
          instructions: "Propose only durable facts, preferences, decisions or commitments supported by an exact sourceQuote from one of these messages. Use memory_reflect_apply with at most 10 add/replace/supersede operations; do not forget or write notes here.",
        });
      }

      if (name === "memory_reflect_apply") {
        if (!source.reflectMessageById) return toolError("Reflection isn't set up on this gateway.");
        if (!Array.isArray(args.operations)) return toolError("operations must be an array.");
        if (args.operations.length > 10) return toolError("At most 10 reflection operations per run.");
        if (
          typeof args.expectedRevision !== "string" ||
          typeof args.throughPosition !== "number" ||
          !Number.isInteger(args.throughPosition) ||
          args.throughPosition < 0 ||
          typeof args.lastMessageId !== "string" ||
          !args.lastMessageId.trim()
        ) {
          return toolError("expectedRevision, throughPosition (non-negative integer) and lastMessageId are required.");
        }
        const lastMsg = await source.reflectMessageById(slug, args.lastMessageId.trim());
        if (!lastMsg) return toolError("lastMessageId wasn't found in this Bot's conversation.");
        if (lastMsg.position !== args.throughPosition) return toolError("throughPosition must match the position of lastMessageId.");
        const current = await readMemoryText({ botDir: dir, sharedFile, scope: "bot" });
        if (current.revision !== args.expectedRevision) return toolError(JSON.stringify({ ok: false, code: "conflict", message: "Memory changed since memory_reflect. Read it again.", revision: current.revision, content: current.text }));
        const state = await readMemoryState(dir);
        const bookmark = state.reflection.lastPosition ?? -1;
        if (args.throughPosition <= bookmark) return toolError("throughPosition must be greater than the current reflection bookmark.");
        const priorLines = current.text.split("\n").filter((line) => line.trim()).length;
        const removals = args.operations.filter((operation: any) => operation?.op === "replace" || operation?.op === "supersede").length;
        if (removals > Math.floor(priorLines * 0.25)) return toolError("Reflection would rewrite more than 25% of the current facts. Propose a smaller batch.");
        let revision = args.expectedRevision;
        const applied: unknown[] = [];
        const skipped: unknown[] = [];
        for (const raw of args.operations) {
          const operation = raw as Record<string, unknown>;
          const op = String(operation.op ?? "");
          if (!["add", "replace", "supersede"].includes(op)) return toolError(JSON.stringify({ ok: false, applied, skipped, message: `Unsupported reflection operation ${op}.` }));
          const messageId = String(operation.sourceMessageId ?? "").trim();
          const quote = String(operation.sourceQuote ?? "").trim();
          const message = messageId ? await source.reflectMessageById(slug, messageId) : null;
          if (!message) return toolError(JSON.stringify({ ok: false, applied, skipped, message: "A reflection source message wasn't found in this Bot's conversation." }));
          if (message.position <= bookmark) return toolError(JSON.stringify({ ok: false, applied, skipped, message: "That message is before the reflection bookmark. Read a new packet." }));
          if (message.position > args.throughPosition) return toolError(JSON.stringify({ ok: false, applied, skipped, message: "A reflection source is beyond the packet's throughPosition." }));
          const checked = checkOwnerEvidence(message.text, quote);
          if (!checked.ok) return toolError(JSON.stringify({ ok: false, applied, skipped, message: checked.message }));
          const result = await mutateMemory({
            botDir: dir,
            sharedFile,
            scope: "bot",
            op: op as "add" | "replace" | "supersede",
            expectedRevision: revision,
            author: slug,
            sourceMessageId: message.id,
            sourceQuote: quote,
            sourceText: message.text,
            fact: typeof operation.fact === "string" ? operation.fact : undefined,
            old: typeof operation.old === "string" ? operation.old : undefined,
            new: typeof operation.new === "string" ? operation.new : undefined,
            category: typeof operation.category === "string" ? operation.category : null,
            validFrom: typeof operation.validFrom === "string" ? operation.validFrom : null,
          });
          if (!result.ok) {
            if (result.code === "duplicate") { skipped.push({ op, fact: operation.fact ?? operation.new ?? "" }); continue; }
            return toolError(JSON.stringify({ ok: false, applied, skipped, result }));
          }
          revision = result.revision;
          applied.push(result);
        }
        await writeReflectionBookmark(dir, { position: args.throughPosition, messageId: args.lastMessageId });
        await appendDream(dir, `${new Date().toISOString().slice(0, 10)}: reflect ${applied.length} applied, ${skipped.length} skipped, through position ${args.throughPosition}`);
        log(`memory: ${slug} reflected ${applied.length} operation(s)`);
        return toolJson({ ok: true, applied, skipped, revision, bookmark: { lastPosition: args.throughPosition, lastMessageId: args.lastMessageId } });
      }

      if (name === "memory_defrag") {
        const op = String(args.op ?? "audit");
        if (op === "safe-dedupe") {
          const result = await runSafeDedupe({ botDir: dir, sharedFile });
          log(`memory: ${slug} defrag safe-dedupe removed ${result.removed}`);
          return toolJson(result);
        }
        if (op === "retire-closed") {
          const result = await runRetireClosed({ botDir: dir, sharedFile });
          log(`memory: ${slug} defrag retire-closed removed ${result.removed}`);
          return toolJson(result);
        }
        if (op !== "audit") return toolError("op must be audit, safe-dedupe or retire-closed.");
        const report = await runDefragAudit({ botDir: dir, sharedFile });
        log(`memory: ${slug} defrag audit wrote ${report.planPath}`);
        return toolJson(report);
      }

      if (name === "memory_search") {
        const query = String(args.query ?? "").trim();
        if (!query) return toolError("Pass a query.");
        const hits = await searchMemory({ botDir: dir, sharedFile, query });
        const filtered = args.scope === "bot" ? hits.filter((hit) => hit.scope !== "shared") : args.scope === "shared" ? hits.filter((hit) => hit.scope === "shared") : hits;
        return toolJson({ query, results: filtered, note: filtered.length ? "Read one result with memory_read topic=<path>." : "Nothing found. Try fewer words or a different phrase." });
      }

      return toolError(`Unknown memory tool ${name}.`);
    } catch (error) {
      return toolError(String((error as { message?: unknown } | null | undefined)?.message ?? error));
    }
  };
}
