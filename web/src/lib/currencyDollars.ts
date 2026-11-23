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
  let out = "", from = 0, pos = 0;
  const runEnd = (at: number) => { let end = at; while (line[end] === "`") end++; return end; };
  while (pos < line.length) {
    const open = line.indexOf("`", pos);
    if (open < 0) break;
    const openEnd = runEnd(open);
    let close = -1;
    for (let next = line.indexOf("`", openEnd); next >= 0; next = line.indexOf("`", runEnd(next))) {
      if (runEnd(next) - next === openEnd - open) { close = runEnd(next); break; }
    }
    if (close < 0) { pos = openEnd; continue; }
    out += escape(line.slice(from, open)) + line.slice(open, close);
    from = pos = close;
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
