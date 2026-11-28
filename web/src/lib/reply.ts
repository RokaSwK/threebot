// T3 stores one text per message, so a reply carries its quote as a leading
// block: the Bot reads it as context and the transcript renders it as a chip.
const REPLY_BLOCK = /^<reply-context>\n?([\s\S]*?)\n?<\/reply-context>\s*/;
const MAX_QUOTE = 1000;

export function withReply(text: string, quote: string | null | undefined) {
  const cleaned = quote?.replace(/<\/?reply-context>/g, "").trim().slice(0, MAX_QUOTE);
  return cleaned ? `<reply-context>\n${cleaned}\n</reply-context>\n\n${text}` : text;
}

export function parseReply(text: string): { quote: string | null; text: string } {
  const match = REPLY_BLOCK.exec(text);
  return match ? { quote: match[1], text: text.slice(match[0].length) } : { quote: null, text };
}

/** The first line of a quote, as the chip shows it. */
export function replyLabel(quote: string) {
  return quote.replace(/\s+/g, " ").trim();
}

/** What Cite adds at the end of a draft: the selection as a Markdown blockquote, then a blank line. */
export function citation(draft: string, selection: string) {
  const quote = selection.replace(/\r\n?/g, "\n").trim().split("\n").map((line) => line.trimEnd() ? `> ${line.trimEnd()}` : ">").join("\n");
  const gap = !draft.trim() || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return quote === ">" ? "" : `${gap}${quote}\n\n`;
}

/** The sentence under a point, as a range inside its paragraph, or null when the point isn't on message text. */
export function sentenceAt(body: HTMLElement, x: number, y: number) {
  const caret = document.caretPositionFromPoint?.(x, y);
  const hit = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? hit?.startContainer, offset = caret?.offset ?? hit?.startOffset ?? 0;
  // Code blocks have no sentences; they keep today's action sheet.
  if (!(node instanceof Text) || !body.contains(node) || node.parentElement?.closest("pre")) return null;
  const found = node.parentElement?.closest("p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,[data-message-body]");
  const block = found && body.contains(found) ? found : body;
  const nodes: { node: Text; start: number }[] = [];
  let text = "", at = -1;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (next === node) at = text.length + offset;
    nodes.push({ node: next as Text, start: text.length }); text += next.textContent ?? "";
  }
  const sentence = [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)].find(({ index, segment }) => at < index + segment.length);
  if (!sentence?.segment.trim()) return null;
  const end = sentence.index + sentence.segment.trimEnd().length;
  const place = (position: number, edge: "start" | "end") => {
    const owner = nodes.findLast(({ start }) => edge === "start" ? start <= position : start < position)!;
    return [owner.node, position - owner.start] as const;
  };
  const range = document.createRange();
  range.setStart(...place(sentence.index, "start")); range.setEnd(...place(end, "end"));
  // Caret lookups snap to the nearest text, so a press on the bubble's padding finds none.
  return [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) ? range : null;
}
