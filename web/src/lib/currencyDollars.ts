// A dollar sign followed by an amount ("$36", "$0.04/hour", "$1.2k", "**$71.88**") is a price, not math.
// Without this, two prices on one line ("$36 … $0.04") read as one inline formula.
const PRICE = /(^|[^\\$\p{L}\p{N}_])\$(?=\d[\d,]*(?:\.\d+)?(?:[kKmMbB]n?|%)?(?:[\s.,;:!?)\]/–—*_~-]|$))/gu;
const FENCE = /^(?: {0,3}>[ \t]?)* {0,3}(`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;

function escapeText(text: string) {
  return text.replace(PRICE, "$1\\$");
}

/** Applies `escape` outside inline code spans: a run of n backticks closes at the next run of exactly n. */
function outsideCode(line: string, escape: (text: string) => string) {
  // Backtick runs as [start, end], each linked to the next run of the same length, in one pass,
  // so an opener that never closes doesn't rescan the rest of the line (hostile lines stay linear).
  const runs: [number, number][] = [];
  for (let at = line.indexOf("`"); at >= 0; at = line.indexOf("`", at)) {
    const start = at;
    while (line[at] === "`") at++;
    runs.push([start, at]);
  }
  const closer = new Array<number>(runs.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][1] - runs[i][0];
    closer[i] = nextOfLength.get(length) ?? -1;
    nextOfLength.set(length, i);
  }
  let out = "", from = 0;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i][0] < from || closer[i] < 0) continue;
    const close = runs[closer[i]][1];
    out += escape(line.slice(from, runs[i][0])) + line.slice(runs[i][0], close);
    from = close;
    i = closer[i];
  }
  return out + escape(line.slice(from));
}

/** Escapes price dollar signs outside code, so remark-math leaves them as text. */
export function escapePriceDollars(markdown: string): string {
  if (!markdown.includes("$")) return markdown;
  let fence: string | null = null;
  let blankBefore = true, indented = false;
  return markdown.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
      return line;
    }
    if (marker) { fence = marker; return line; }
    if (!line.trim()) { blankBefore = true; return line; }
    // An indented code block starts after a blank line and runs until a line that isn't indented.
    indented = INDENTED.test(line) && (blankBefore || indented);
    blankBefore = false;
    return indented ? line : outsideCode(line, escapeText);
  }).join("\n");
}
