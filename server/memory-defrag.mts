// Defrag audits the whole memory store and writes a plan before anything destructive. The first
// implementation is deliberately non-destructive: it detects duplicates, broken links, oversized
// notes, stale ranges and possible contradictions, and can safely remove byte-identical duplicate
// fact lines. Moving facts, deleting notes or picking a contradiction winner needs a human.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MEMORY_LIMITS,
  appendDream,
  dedupeExactFacts,
  listMemoryNotes,
  normalizeFact,
  readMemoryNoteWithRevision,
  readMemoryText,
  readMemoryView,
  writeTextAtomic,
  type MemoryFactView,
  type MemoryLimits,
  type MemoryScope,
} from "./memory.mts";

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
    facts: number;
    sharedFacts: number;
    notes: number;
    exactDuplicateFacts: number;
    nearDuplicateFacts: number;
    brokenLinks: number;
    oversizedNotes: number;
    staleFacts: number;
    possibleContradictions: number;
    overBudget: number;
  };
  safeDedupe: { bot: boolean; shared: boolean };
  limits: MemoryLimits;
};

const NEGATION = /\b(no|not|nunca|never|don'?t|doesn'?t|isn'?t|ya no)\b/iu;

function localDate(now: Date): string {
  const shifted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function words(value: string): Set<string> {
  return new Set(normalizeFact(value).split(/[^a-z0-9áéíóúüñ]+/iu).filter((word) => word.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function duplicateKey(fact: MemoryFactView): string {
  return normalizeFact(fact.text);
}

function exactLineKey(line: string): string {
  return line.trim();
}

function negativeKey(fact: MemoryFactView): string {
  return normalizeFact(fact.text.replace(NEGATION, " "));
}

async function raw(file: string): Promise<string> {
  return await fs.readFile(file, "utf8").catch(() => "");
}

function brokenTarget(target: string, currentPath: string, notePaths: Set<string>): boolean {
  const clean = target.split("#", 1)[0]!.trim().replace(/\.md$/iu, "");
  if (!clean) return true;
  const candidates = [
    clean.startsWith("memory/notes/") ? `${clean}.md` : "",
    clean.startsWith("notes/") ? `memory/${clean}.md` : "",
    `memory/notes/${clean}.md`,
    path.posix.join(path.posix.dirname(currentPath), `${clean}.md`),
  ].filter(Boolean);
  return !candidates.some((candidate) => notePaths.has(candidate));
}

/** Audit without changing a memory file. The returned plan path is filled by writeDefragPlan. */
export async function analyzeMemoryStore({ botDir, sharedFile, now = new Date() }: { botDir: string; sharedFile: string; now?: Date }): Promise<DefragReport> {
  const [view, botRaw, sharedRaw, allNotes] = await Promise.all([
    readMemoryView({ botDir, sharedFile }),
    raw(path.join(botDir, "memory", "MEMORY.md")),
    raw(sharedFile),
    listMemoryNotes(botDir),
  ]);
  const notes = allNotes.filter((note) => !note.path.startsWith("memory/notes/defrag/"));
  const limits = { ...MEMORY_LIMITS };
  const findings: DefragFinding[] = [];
  const allFacts = [...view.bot.facts, ...view.shared.facts];
  const exactGroups = new Map<string, MemoryFactView[]>();
  for (const fact of allFacts) {
    const key = exactLineKey(fact.line);
    const list = exactGroups.get(key) ?? [];
    list.push(fact);
    exactGroups.set(key, list);
  }
  let exactDuplicateFacts = 0;
  for (const [line, group] of exactGroups) if (group.length > 1) {
    exactDuplicateFacts += group.length - 1;
    findings.push({ kind: "duplicate", severity: "safe", detail: `${group.length - 1} duplicate line(s) can be removed without losing a source.`, lines: [line] });
  }
  const byText = new Map<string, MemoryFactView[]>();
  for (const fact of allFacts) {
    const key = duplicateKey(fact);
    const list = byText.get(key) ?? [];
    list.push(fact);
    byText.set(key, list);
  }
  let nearDuplicateFacts = 0;
  const seenPairs = new Set<string>();
  for (let i = 0; i < allFacts.length; i += 1) {
    for (let j = i + 1; j < allFacts.length; j += 1) {
      const a = allFacts[i]!, b = allFacts[j]!;
      if (duplicateKey(a) === duplicateKey(b)) continue;
      const pair = [a.line, b.line].sort().join("\u0000");
      if (seenPairs.has(pair)) continue;
      if (jaccard(words(a.text), words(b.text)) >= 0.7) {
        seenPairs.add(pair);
        nearDuplicateFacts += 1;
        findings.push({ kind: "near_duplicate", severity: "review", detail: "These facts are close enough that one may be a rewording; review before merging.", lines: [a.line, b.line] });
      }
    }
  }
  let possibleContradictions = 0;
  for (const group of byText.values()) {
    if (group.length < 2) continue;
    const positive = group.find((fact) => !NEGATION.test(fact.text));
    const negative = group.find((fact) => NEGATION.test(fact.text));
    if (positive && negative) {
      possibleContradictions += 1;
      findings.push({ kind: "possible_contradiction", severity: "review", detail: "One line says this and another negates it; don't pick a winner without a dated source.", lines: [positive.line, negative.line] });
    }
  }
  // A second, cheap contradiction shape: same topic words, opposite negation.
  const byNegativeKey = new Map<string, MemoryFactView[]>();
  for (const fact of allFacts) {
    const key = negativeKey(fact);
    const list = byNegativeKey.get(key) ?? [];
    list.push(fact);
    byNegativeKey.set(key, list);
  }
  for (const group of byNegativeKey.values()) {
    if (group.length < 2) continue;
    const positive = group.find((fact) => !NEGATION.test(fact.text));
    const negative = group.find((fact) => NEGATION.test(fact.text));
    if (positive && negative && duplicateKey(positive) !== duplicateKey(negative)) {
      possibleContradictions += 1;
      findings.push({ kind: "possible_contradiction", severity: "review", detail: "A fact and its negation share the same words; review the source before choosing.", lines: [positive.line, negative.line] });
    }
  }
  const today = localDate(now);
  let staleFacts = 0;
  for (const fact of allFacts) {
    if (fact.validTo && fact.validTo < today) {
      staleFacts += 1;
      findings.push({ kind: "stale_fact", severity: "info", detail: `Closed fact (valid until ${fact.validTo}); move it to notes/history during defrag.`, lines: [fact.line] });
    }
  }
  const notePaths = new Set(notes.map((note) => note.path));
  let brokenLinks = 0;
  let orphanNotes = 0;
  const incoming = new Set<string>();
  for (const note of notes) {
    const content = (await readMemoryNoteWithRevision(botDir, note.path)).text;
    const links = [...content.matchAll(/\[\[([^\]\n]{1,200})\]\]/gu)].map((match) => match[1]!.trim());
    for (const target of links) {
      const clean = target.split("#", 1)[0]!.trim();
      const resolved = clean.startsWith("memory/notes/") ? `${clean}.md` : clean.startsWith("notes/") ? `memory/${clean}.md` : `memory/notes/${clean}.md`;
      if (notePaths.has(resolved)) incoming.add(resolved);
      else {
        brokenLinks += 1;
        findings.push({ kind: "broken_link", severity: "review", detail: `Broken link [[${target}]].`, paths: [note.path] });
      }
    }
  }
  for (const note of notes) {
    if (!incoming.has(note.path)) {
      orphanNotes += 1;
      findings.push({ kind: "orphan_note", severity: "info", detail: "No other note links to this one; link it from a topic note or retire it.", paths: [note.path] });
    }
  }
  let oversizedNotes = 0;
  for (const note of notes) {
    if (note.tokens >= limits.noteTokens || note.chars >= limits.noteChars) {
      oversizedNotes += 1;
      findings.push({ kind: "oversized_note", severity: "review", detail: `Note is at ${note.chars} chars / ${note.tokens} tokens; split it during defrag.`, paths: [note.path] });
    }
  }
  const botLines = botRaw.split("\n").filter((line) => line.trim()).length;
  const sharedLines = sharedRaw.split("\n").filter((line) => line.trim()).length;
  let overBudget = 0;
  if (botLines > limits.memoryLines || botRaw.length > limits.memoryChars) {
    overBudget += 1;
    findings.push({ kind: "over_budget", severity: "review", detail: `MEMORY.md is ${botLines} lines / ${botRaw.length} chars; move detail into notes.`, paths: ["MEMORY.md"] });
  }
  if (sharedLines > limits.snapshotSharedLines * 6 || sharedRaw.length > limits.memoryChars) {
    overBudget += 1;
    findings.push({ kind: "over_budget", severity: "review", detail: "Shared memory is larger than its snapshot budget; review the shared facts.", paths: ["shared-memory.md"] });
  }
  return {
    generatedAt: now.toISOString(),
    planPath: null,
    findings,
    counts: {
      facts: view.bot.facts.length,
      sharedFacts: view.shared.facts.length,
      notes: notes.length,
      exactDuplicateFacts,
      nearDuplicateFacts,
      brokenLinks,
      oversizedNotes,
      staleFacts,
      possibleContradictions,
      overBudget,
    },
    safeDedupe: { bot: view.bot.facts.some((fact, index, list) => list.findIndex((other) => exactLineKey(other.line) === exactLineKey(fact.line)) !== index), shared: view.shared.facts.some((fact, index, list) => list.findIndex((other) => exactLineKey(other.line) === exactLineKey(fact.line)) !== index) },
    limits,
  };
}

/** Write the proposed plan as a note. This is the only file Defrag creates. */
export async function writeDefragPlan({ botDir, report, now = new Date() }: { botDir: string; report: DefragReport; now?: Date }): Promise<string> {
  const date = localDate(now);
  const relative = `memory/notes/defrag/${date}.md`;
  const absolute = path.join(botDir, relative);
  const lines = [
    "---",
    `description: Defrag plan for ${date}`,
    "type: defrag-plan",
    `status: proposed`,
    "---",
    `# Defrag plan ${date}`,
    "",
    report.findings.length ? report.findings.map((finding) => `- [${finding.kind}] ${finding.detail}${finding.paths?.length ? ` (${finding.paths.join(", ")})` : ""}${finding.lines?.length ? `\n  - ${finding.lines.join("\n  - ")}` : ""}`).join("\n") : "- No issues found.",
    "",
    "> Nothing destructive was applied. Exact duplicate fact lines are safe to dedupe; everything else needs a human decision.",
    "",
  ];
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await writeTextAtomic(absolute, lines.join("\n"), 0o644);
  report.planPath = relative;
  return relative;
}

export async function runDefragAudit({ botDir, sharedFile, now = new Date() }: { botDir: string; sharedFile: string; now?: Date }): Promise<DefragReport> {
  const report = await analyzeMemoryStore({ botDir, sharedFile, now });
  await writeDefragPlan({ botDir, report: report, now });
  return report;
}

/** Lossless cleanup: only byte-identical duplicate fact lines. */
export async function runSafeDedupe({ botDir, sharedFile, now = new Date() }: { botDir: string; sharedFile: string; now?: Date }): Promise<{ bot: Awaited<ReturnType<typeof dedupeExactFacts>>; shared: Awaited<ReturnType<typeof dedupeExactFacts>>; removed: number }> {
  const [bot, shared] = await Promise.all([
    readMemoryText({ botDir, sharedFile, scope: "bot" }),
    readMemoryText({ botDir, sharedFile, scope: "shared" }),
  ]);
  const botResult = await dedupeExactFacts({ botDir, sharedFile, scope: "bot", expectedRevision: bot.revision, now });
  const sharedResult = await dedupeExactFacts({ botDir, sharedFile, scope: "shared", expectedRevision: shared.revision, now });
  const removed = (botResult.ok ? botResult.removed : 0) + (sharedResult.ok ? sharedResult.removed : 0);
  if (removed > 0) await appendDream(botDir, `${localDate(now)}: defrag removed ${removed} exact duplicate fact line(s)`);
  return { bot: botResult, shared: sharedResult, removed };
}
