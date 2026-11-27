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
