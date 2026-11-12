// Pure module for @ mention boundaries, query extraction, and mention parsing.
// Shared between the web UI composer and the server room engine.

const MENTION_BOUNDARY_PREV = /[\s([{<'"“`*~.]/;

/** True if character at `at` is '@' and satisfies word-boundary rules for mentions. */
export function isMentionBoundary(text: string, at: number): boolean {
  if (at < 0 || at >= text.length || text[at] !== "@") return false;
  if (at === 0) return true;
  const prev = text[at - 1];
  if (/[a-zA-Z0-9_\/@]/.test(prev)) return false;
  return MENTION_BOUNDARY_PREV.test(prev);
}

/** True if the character immediately following a matched name is a continuation of a word/identifier. */
export function isNameContinuation(rest: string): boolean {
  return rest.length > 0 && /[\p{L}\p{N}_]/u.test(rest[0]);
}

/**
 * Finds the active mention query at the cursor position.
 * Returns { start, query } where `start` is the index of '@', or null if no active query.
 */
export function mentionQueryAt(
  text: string,
  cursor: number,
  names?: readonly string[]
): { start: number; query: string } | null {
  if (cursor < 0 || cursor > text.length) return null;

  for (let i = cursor - 1; i >= Math.max(0, cursor - 33); i--) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") return null;
    if (ch === "@") {
      if (!isMentionBoundary(text, i)) return null;
      const query = text.slice(i + 1, cursor);
      if (query.length > 32 || query.includes("\n") || query.includes("\r")) return null;
      if (names && names.some((n) => query === `${n} ` || query.toLowerCase() === `${n.toLowerCase()} `)) {
        return null;
      }
      return { start: i, query };
    }
  }
  return null;
}

function stripCode(src: string): string {
  // Replace fenced code blocks: ```...``` or ~~~...~~~
  const withoutFences = src.replace(/(^|\n)[ \t]*(```+|~~~+)[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, (match, prefix) => {
    return prefix + " ".repeat(match.length - prefix.length);
  });
  // Replace inline code: `...` or ``...``
  return withoutFences.replace(/(`+)[\s\S]*?\1/g, (match) => " ".repeat(match.length));
}

export type MentionSegment = { text: string; bot?: string };

/**
 * Splits `text` into plain runs and bot mentions. One source of truth for the composer, the
 * message renderer and the room parser: same boundary rule, longest name first, no match inside
 * fenced/inline code, and the returned `text` is the original slice (not the code-masked text).
 */
export function mentionSegments(text: string, names: readonly string[]): MentionSegment[] {
  const masked = stripCode(text);
  const candidates = Array.from(new Set(names.filter((name) => name.trim() !== ""))).sort((a, b) => b.length - a.length);
  const canonical = (matched: string): string => names.find((n) => n.toLowerCase() === matched.toLowerCase()) ?? matched;
  const segments: MentionSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") {
      segments.push({ text: plain });
      plain = "";
    }
  };

  let i = 0;
  while (i < masked.length) {
    if (masked[i] === "@" && isMentionBoundary(masked, i)) {
      const hit = candidates.find((candidate) => {
        if (!masked.slice(i + 1).toLowerCase().startsWith(candidate.toLowerCase())) return false;
        return !isNameContinuation(masked.slice(i + 1 + candidate.length));
      });
      if (hit !== undefined) {
        flush();
        segments.push({ text: text.slice(i, i + 1 + hit.length), bot: canonical(hit) });
        i += 1 + hit.length;
        continue;
      }
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return segments;
}

/**
 * Extracts mentions from text matching any of `names` (and `@all`).
 * Ignores fenced and inline code, matches longest names first, and respects the policy.
 */
export function mentionsInText(
  text: string,
  names: readonly string[],
  policy: "anywhere" | "leading"
): string[] {
  const stripped = stripCode(text);
  const candidateNames = Array.from(new Set([...names, "all"])).sort((a, b) => b.length - a.length);

  const resolveCanonical = (matched: string): string => {
    if (matched.toLowerCase() === "all") return "all";
    return names.find((n) => n.toLowerCase() === matched.toLowerCase()) ?? matched;
  };

  const results: string[] = [];

  if (policy === "leading") {
    let idx = stripped.search(/\S/);
    if (idx === -1) return [];

    while (idx < stripped.length) {
      if (stripped[idx] !== "@" || !isMentionBoundary(stripped, idx)) break;
      let matched = false;
      for (const c of candidateNames) {
        if (stripped.slice(idx + 1).toLowerCase().startsWith(c.toLowerCase())) {
          const rest = stripped.slice(idx + 1 + c.length);
          if (!isNameContinuation(rest)) {
            results.push(resolveCanonical(c));
            idx = idx + 1 + c.length;
            matched = true;
            break;
          }
        }
      }
      if (!matched) break;

      const rest = stripped.slice(idx);
      const sepMatch = /^(\s*(?:,|and|&|\s)\s*)+/i.exec(rest);
      if (sepMatch) {
        idx += sepMatch[0].length;
        if (idx < stripped.length && stripped[idx] === "@") {
          continue;
        }
      }
      break;
    }
    return Array.from(new Set(results));
  }

  // policy === "anywhere"
  return Array.from(new Set(
    mentionSegments(text, [...names, "all"]).flatMap((segment) => (segment.bot === undefined ? [] : [segment.bot]))
  ));
}
