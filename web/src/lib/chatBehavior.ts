// Narrow windows and touch devices both need tap-only keyboard activation.
export const MOBILE_CHAT_QUERY = "(max-width: 760px), (pointer: coarse)";

type ComposerTarget = Pick<HTMLTextAreaElement, "readOnly" | "focus" | "blur">;

/** Keep focus restoration from overlays from reopening the software keyboard. */
export function composerFocusBehavior(requiresTap: boolean) {
  let state: "idle" | "tapped" | "editing" = "idle";
  return {
    onEntry(target: ComposerTarget | null) {
      state = "idle";
      if (!target) return;
      target.readOnly = requiresTap;
      if (requiresTap) target.blur();
      else target.focus();
    },
    onPointerDown(target: ComposerTarget) {
      if (!requiresTap) return;
      if (state !== "editing") state = "tapped";
      // This must happen before the pointer's default focus action, including on iOS.
      target.readOnly = false;
    },
    onClick(target: ComposerTarget) {
      // Screen readers and accessibility automation can activate with click
      // alone. Read-only tap protection must not strand those users.
      if (!requiresTap || state === "editing") return;
      state = "tapped";
      target.readOnly = false;
      target.focus();
    },
    onFocus(target: ComposerTarget) {
      if (requiresTap && state === "idle") {
        state = "idle";
        target.readOnly = true;
        target.blur();
        return;
      }
      state = "editing";
    },
    onBlur(target: ComposerTarget) {
      state = "idle";
      target.readOnly = requiresTap;
    },
    onPointerCancel(target: ComposerTarget) {
      if (state !== "tapped") return;
      state = "idle";
      if (requiresTap) target.readOnly = true;
    },
  };
}

/** Snapshot before resetting so the same file can be picked again after removal. */
export function takeAttachmentFiles(input: Pick<HTMLInputElement, "files" | "value">): File[] {
  const files = Array.from(input.files ?? []);
  input.value = "";
  return files;
}

export function splitBubbles(text: string): string[] {
  // Block Markdown must reach its parser intact, including unfinished streamed
  // blocks. Keep the original bytes rather than splitting at internal blank lines.
  if (text.length > 900 || /```|~~~|\$\$|\\\[|\n\|/.test(text)) return [text];
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  // Keep lists attached to the sentence that introduces them.
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && (/^([•\-*]|\d+\.)\s/.test(p) || /:$/.test(out[out.length - 1]))) out[out.length - 1] += "\n\n" + p;
    else out.push(p);
  }
  return out.length > 4 ? [text] : out;
}

/** `/clear` on its own starts a fresh session with the next message, as in T3 Code. */
export function isClearCommand(text: string) {
  return /^\/clear\s*$/i.test(text.trim());
}

export const LIST_ITEM_REGEX = /^(\s*)(?:([•\-*+–—])\s+(?:\[([ xX])\]\s+)?|(\d+)([\.\)])\s+)/;
export const BULLET_TRIGGER_REGEX = /^(\s*)[-*+–—]$/;
export const ORDERED_TRIGGER_REGEX = /^(\s*)(1)[\.\)]$/;

/** Normalize visual bullet points (•) and composer indentation to Markdown-standard list markers (-) */
export function normalizeComposerLists(text: string): string {
  // Normalize visual bullet points (•) and composer 4-space indentation to Markdown
  let res = text.replace(/^([ \t]*)•[ \t]+/gm, (_, spaces) => {
    const expanded = spaces.replace(/\t/g, "    ");
    const len = expanded.length;
    if (len >= 4) {
      const level = Math.floor(len / 4) - 1;
      const remainder = len % 4;
      const mdSpaces = "  ".repeat(level) + " ".repeat(remainder);
      return mdSpaces + "- ";
    }
    return spaces + "- ";
  });
  // Normalize ordered list composer 4-space indentation to Markdown
  res = res.replace(/^([ \t]+)(\d+[\.\)])[ \t]+/gm, (_, spaces, marker) => {
    const expanded = spaces.replace(/\t/g, "    ");
    const len = expanded.length;
    if (len >= 4) {
      const level = Math.floor(len / 4) - 1;
      const remainder = len % 4;
      const mdSpaces = "  ".repeat(level) + " ".repeat(remainder);
      return mdSpaces + marker + " ";
    }
    return spaces + marker + " ";
  });
  return res;
}

/** Check if text contains any list item (bullet or ordered) */
export function hasComposerList(text: string): boolean {
  return /(?:^|\n)\s*(?:[•\-*+–—]|\d+[\.\)])\s/.test(text);
}

/** Ensure the active cursor position inside the textarea is visible in view. */
export function scrollTextareaToCursor(el: { selectionStart: number; value: string; clientHeight?: number; scrollHeight?: number; scrollTop?: number }) {
  if (typeof el.scrollTop !== "number" || typeof el.scrollHeight !== "number") return;
  const clientHeight = el.clientHeight ?? 120;
  if (el.scrollHeight <= clientHeight) return;

  // If at or near the end of the text, scroll all the way to bottom
  if (el.selectionStart >= el.value.length - 2) {
    el.scrollTop = el.scrollHeight;
    return;
  }

  // Calculate cursor line position
  const textBefore = el.value.slice(0, el.selectionStart);
  const linesBefore = textBefore.split("\n").length;
  const totalLines = Math.max(el.value.split("\n").length, 1);
  const lineHeight = el.scrollHeight / totalLines;
  const cursorTop = (linesBefore - 1) * lineHeight;
  const cursorBottom = cursorTop + lineHeight;

  if (cursorTop < el.scrollTop) {
    el.scrollTop = Math.max(0, cursorTop);
  } else if (cursorBottom > el.scrollTop + clientHeight) {
    el.scrollTop = cursorBottom - clientHeight;
  }
}

/** Handle list triggers on input (e.g. typing space or list item on mobile virtual keyboards or IME) */
export function transformComposerInput(
  value: string,
  selectionStart: number
): { value: string; cursor: number } | null {
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineEndIndex = value.indexOf("\n", selectionStart);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const line = value.slice(lineStart, lineEnd);

  // Bullet list trigger: line starts with optional whitespace + dash/star/plus/en-dash/em-dash + space
  const bulletMatch = line.match(/^(\s*)([-*+–—])[\s\u00A0]+(.*)$/);
  if (bulletMatch) {
    const origIndent = bulletMatch[1];
    const indent = origIndent.length < 4 ? "    " : origIndent;
    const rest = bulletMatch[3];
    const replacement = indent + "• " + rest;
    const nextValue = value.slice(0, lineStart) + replacement + value.slice(lineEnd);
    const origPrefixLen = bulletMatch[0].length - rest.length;
    const newPrefixLen = indent.length + 2; // indent + "• "
    const diff = newPrefixLen - origPrefixLen;
    const newCursor = Math.max(lineStart + newPrefixLen, selectionStart + diff);
    return { value: nextValue, cursor: newCursor };
  }

  // Ordered list trigger: line starts with optional whitespace + 1. or 1) + space
  const orderedMatch = line.match(/^(\s*)(1[\.\)])[\s\u00A0]+(.*)$/);
  if (orderedMatch) {
    const origIndent = orderedMatch[1];
    if (origIndent.length < 4) {
      const indent = "    ";
      const marker = orderedMatch[2];
      const rest = orderedMatch[3];
      const replacement = indent + marker + " " + rest;
      const nextValue = value.slice(0, lineStart) + replacement + value.slice(lineEnd);
      const origPrefixLen = orderedMatch[0].length - rest.length;
      const newPrefixLen = indent.length + marker.length + 1;
      const diff = newPrefixLen - origPrefixLen;
      const newCursor = Math.max(lineStart + newPrefixLen, selectionStart + diff);
      return { value: nextValue, cursor: newCursor };
    }
  }

  return null;
}

export type ListKeyTarget = Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd" | "setSelectionRange" | "readOnly"> & {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
};

function handleListSpace(
  textarea: ListKeyTarget,
  value: string,
  selectionStart: number,
  lineStart: number,
  lineBeforeCursor: string,
  setText: (value: string) => void,
  onCursor?: (cursor: number) => void
): boolean {
  const bulletMatch = lineBeforeCursor.match(BULLET_TRIGGER_REGEX);
  if (bulletMatch) {
    const origIndent = bulletMatch[1];
    const indent = origIndent.length < 4 ? "    " : origIndent;
    const replacement = indent + "• ";
    const nextValue = value.slice(0, lineStart) + replacement + value.slice(selectionStart);
    const newCursor = lineStart + replacement.length;
    textarea.value = nextValue;
    textarea.setSelectionRange(newCursor, newCursor);
    setText(nextValue);
    onCursor?.(newCursor);
    scrollTextareaToCursor(textarea);
    return true;
  }

  const orderedMatch = lineBeforeCursor.match(ORDERED_TRIGGER_REGEX);
  if (orderedMatch) {
    const origIndent = orderedMatch[1];
    const indent = origIndent.length < 4 ? "    " : origIndent;
    const delim = lineBeforeCursor.slice(-1);
    const replacement = indent + "1" + delim + " ";
    const nextValue = value.slice(0, lineStart) + replacement + value.slice(selectionStart);
    const newCursor = lineStart + replacement.length;
    textarea.value = nextValue;
    textarea.setSelectionRange(newCursor, newCursor);
    setText(nextValue);
    onCursor?.(newCursor);
    scrollTextareaToCursor(textarea);
    return true;
  }

  return false;
}

function handleListNewline(
  textarea: ListKeyTarget,
  value: string,
  selectionStart: number,
  lineStart: number,
  lineEnd: number,
  line: string,
  match: RegExpMatchArray,
  setText: (value: string) => void,
  onCursor?: (cursor: number) => void
): boolean {
  const markerLength = match[0].length;
  const markerEnd = lineStart + markerLength;
  if (selectionStart < markerEnd) return false;

  const content = line.slice(markerLength);
  if (content.trim() === "") {
    // Empty item: exit list by completely removing the empty marker line
    const nextValue = value.slice(0, lineStart) + value.slice(lineEnd);
    textarea.value = nextValue;
    textarea.setSelectionRange(lineStart, lineStart);
    setText(nextValue);
    onCursor?.(lineStart);
    scrollTextareaToCursor(textarea);
    return true;
  }

  const indent = match[1] && match[1].length >= 4 ? match[1] : "    ";
  let nextMarker = "";
  let linePrefixAdjustment = 0;
  let lineReplaced = value;

  if (match[2]) {
    const hasCheckbox = match[3] !== undefined;
    nextMarker = indent + "• " + (hasCheckbox ? "[ ] " : "");
    // If the current line's marker was '-' / '*' / '+' / en-dash or under-indented, normalize it to '    • '
    if (match[2] !== "•" || !match[1] || match[1].length < 4) {
      const currentMarker = match[0];
      const newCurrentMarker = indent + "• " + (hasCheckbox ? (match[3] ? `[${match[3]}] ` : "[ ] ") : "");
      lineReplaced = value.slice(0, lineStart) + newCurrentMarker + value.slice(markerEnd);
      linePrefixAdjustment = newCurrentMarker.length - currentMarker.length;
    }
  } else if (match[4]) {
    const nextNum = parseInt(match[4], 10) + 1;
    nextMarker = indent + nextNum + match[5] + " ";
    if (!match[1] || match[1].length < 4) {
      const currentMarker = match[0];
      const newCurrentMarker = indent + match[4] + match[5] + " ";
      lineReplaced = value.slice(0, lineStart) + newCurrentMarker + value.slice(markerEnd);
      linePrefixAdjustment = newCurrentMarker.length - currentMarker.length;
    }
  }

  const adjustedSelection = selectionStart + linePrefixAdjustment;
  const insertion = "\n" + nextMarker;
  const remainder = lineReplaced.slice(adjustedSelection).replace(/^\s/, "");
  const nextValue = lineReplaced.slice(0, adjustedSelection) + insertion + remainder;
  const newCursor = adjustedSelection + insertion.length;

  textarea.value = nextValue;
  textarea.setSelectionRange(newCursor, newCursor);
  setText(nextValue);
  onCursor?.(newCursor);
  scrollTextareaToCursor(textarea);
  return true;
}

function handleListBackspace(
  textarea: ListKeyTarget,
  value: string,
  selectionStart: number,
  lineStart: number,
  lineEnd: number,
  line: string,
  match: RegExpMatchArray,
  setText: (value: string) => void,
  onCursor?: (cursor: number) => void
): boolean {
  const markerLength = match[0].length;
  const markerEnd = lineStart + markerLength;
  if (selectionStart === markerEnd) {
    const content = line.slice(markerLength);
    // If empty item, remove the whole empty line; otherwise remove just the marker
    const nextValue = content.trim() === ""
      ? value.slice(0, lineStart) + value.slice(lineEnd)
      : value.slice(0, lineStart) + value.slice(markerEnd);
    textarea.value = nextValue;
    textarea.setSelectionRange(lineStart, lineStart);
    setText(nextValue);
    onCursor?.(lineStart);
    scrollTextareaToCursor(textarea);
    return true;
  }
  return false;
}

/** Automatically continue or cleanly exit markdown lists on newline / backspace. */
export function handleComposerListKey(
  e: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; nativeEvent?: { isComposing?: boolean }; preventDefault: () => void; currentTarget: ListKeyTarget },
  mobile: boolean,
  setText: (value: string) => void,
  onCursor?: (cursor: number) => void
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || (!mobile && e.nativeEvent?.isComposing)) return false;
  const textarea = e.currentTarget;
  if (textarea.readOnly) return false;
  const { selectionStart, selectionEnd, value } = textarea;
  if (selectionStart !== selectionEnd) return false;

  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineEndIndex = value.indexOf("\n", selectionStart);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const line = value.slice(lineStart, lineEnd);
  const lineBeforeCursor = value.slice(lineStart, selectionStart);

  // Transform trigger markers on Space: "-" / "*" / "+" -> "  • ", and "1." -> "  1. "
  if (e.key === " " && !e.shiftKey) {
    if (handleListSpace(textarea, value, selectionStart, lineStart, lineBeforeCursor, setText, onCursor)) {
      e.preventDefault();
      return true;
    }
  }

  const isNewline = e.key === "Enter" && (mobile || e.shiftKey);
  const isBackspace = e.key === "Backspace" && !e.shiftKey;
  if (!isNewline && !isBackspace) return false;

  const match = line.match(LIST_ITEM_REGEX);
  if (!match) return false;

  if (isNewline) {
    if (handleListNewline(textarea, value, selectionStart, lineStart, lineEnd, line, match, setText, onCursor)) {
      e.preventDefault();
      return true;
    }
  }

  if (isBackspace) {
    if (handleListBackspace(textarea, value, selectionStart, lineStart, lineEnd, line, match, setText, onCursor)) {
      e.preventDefault();
      return true;
    }
  }

  return false;
}

/** Handle list triggers and continuation for input events (e.g. beforeinput on mobile). */
export function handleComposerBeforeInput(
  e: { data?: string | null; inputType?: string; preventDefault: () => void; currentTarget: ListKeyTarget },
  mobile: boolean,
  setText: (value: string) => void,
  onCursor?: (cursor: number) => void
): boolean {
  const textarea = e.currentTarget;
  if (textarea.readOnly) return false;
  const { selectionStart, selectionEnd, value } = textarea;
  if (selectionStart !== selectionEnd) return false;

  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineEndIndex = value.indexOf("\n", selectionStart);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const line = value.slice(lineStart, lineEnd);
  const lineBeforeCursor = value.slice(lineStart, selectionStart);

  // Space insertion (mobile virtual keyboard or IME)
  if (e.data === " " || e.data === "\u00A0") {
    if (handleListSpace(textarea, value, selectionStart, lineStart, lineBeforeCursor, setText, onCursor)) {
      e.preventDefault();
      return true;
    }
  }

  // Return / Enter on mobile
  if (mobile && (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak")) {
    const match = line.match(LIST_ITEM_REGEX);
    if (match) {
      if (handleListNewline(textarea, value, selectionStart, lineStart, lineEnd, line, match, setText, onCursor)) {
        e.preventDefault();
        return true;
      }
    }
  }

  // Backspace on mobile
  if (mobile && e.inputType === "deleteContentBackward") {
    const match = line.match(LIST_ITEM_REGEX);
    if (match) {
      if (handleListBackspace(textarea, value, selectionStart, lineStart, lineEnd, line, match, setText, onCursor)) {
        e.preventDefault();
        return true;
      }
    }
  }

  return false;
}
