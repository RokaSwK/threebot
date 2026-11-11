import assert from "node:assert/strict";
import { test } from "node:test";
import { handleComposerBeforeInput, handleComposerListKey, hasComposerList, normalizeComposerLists, scrollTextareaToCursor, transformComposerInput } from "../src/lib/chatBehavior.ts";

function createMockTextarea(initialValue: string, selectionStart = initialValue.length, selectionEnd = selectionStart, readOnly = false) {
  let val = initialValue;
  let start = selectionStart;
  let end = selectionEnd;
  let sTop = 0;
  let sHeight = 100;
  let cHeight = 40;
  return {
    get value() { return val; },
    set value(v: string) { val = v; },
    get selectionStart() { return start; },
    set selectionStart(s: number) { start = s; },
    get selectionEnd() { return end; },
    set selectionEnd(e: number) { end = e; },
    get scrollTop() { return sTop; },
    set scrollTop(t: number) { sTop = t; },
    get scrollHeight() { return sHeight; },
    set scrollHeight(h: number) { sHeight = h; },
    get clientHeight() { return cHeight; },
    set clientHeight(h: number) { cHeight = h; },
    readOnly,
    setSelectionRange(s: number, e: number) {
      start = s;
      end = e;
    },
  };
}

function simulateKey(
  textarea: ReturnType<typeof createMockTextarea>,
  key: string,
  { shiftKey = false, mobile = false, ctrlKey = false, metaKey = false, isComposing = false } = {}
) {
  let defaultPrevented = false;
  let text = textarea.value;
  const event = {
    key,
    shiftKey,
    ctrlKey,
    metaKey,
    altKey: false,
    nativeEvent: { isComposing },
    preventDefault: () => { defaultPrevented = true; },
    currentTarget: textarea,
  };
  const handled = handleComposerListKey(event as any, mobile, (next) => { text = next; });
  return { handled, defaultPrevented, text, textarea };
}

function simulateBeforeInput(
  textarea: ReturnType<typeof createMockTextarea>,
  { data = null as string | null, inputType = "insertText", mobile = false } = {},
  onCursor?: (cursor: number) => void
) {
  let defaultPrevented = false;
  let text = textarea.value;
  const event = {
    data,
    inputType,
    preventDefault: () => { defaultPrevented = true; },
    currentTarget: textarea,
  };
  const handled = handleComposerBeforeInput(event as any, mobile, (next) => { text = next; }, onCursor);
  return { handled, defaultPrevented, text, textarea };
}

test("typing '-' and pressing Space converts immediately to indented bullet dot '    • '", () => {
  const ta = createMockTextarea("-");
  const result = simulateKey(ta, " ");
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • ");
  assert.equal(ta.value, "    • ");
  assert.equal(ta.selectionStart, 6);
});

test("typing '*' and pressing Space converts to '    • '", () => {
  const ta = createMockTextarea("*");
  const result = simulateKey(ta, " ");
  assert.equal(result.handled, true);
  assert.equal(result.text, "    • ");
  assert.equal(ta.selectionStart, 6);
});

test("typing en-dash and pressing Space converts to '    • '", () => {
  const ta = createMockTextarea("–");
  const result = simulateKey(ta, " ");
  assert.equal(result.handled, true);
  assert.equal(result.text, "    • ");
  assert.equal(ta.selectionStart, 6);
});

test("typing '1.' and pressing Space indents with '    1. '", () => {
  const ta = createMockTextarea("1.");
  const result = simulateKey(ta, " ");
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    1. ");
  assert.equal(ta.value, "    1. ");
  assert.equal(ta.selectionStart, 7);
});

test("continues bullet list with Shift+Enter on desktop with visual bullet dot", () => {
  const ta = createMockTextarea("    • Item 1");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • Item 1\n    • ");
  assert.equal(ta.value, "    • Item 1\n    • ");
  assert.equal(ta.selectionStart, 19);
  assert.equal(ta.selectionEnd, 19);
});

test("continues numbered list with increment on Shift+Enter", () => {
  const ta = createMockTextarea("    1. First step");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    1. First step\n    2. ");
  assert.equal(ta.value, "    1. First step\n    2. ");
  assert.equal(ta.selectionStart, 25);
});

test("increments numbered list with parenthesis delimiter", () => {
  const ta = createMockTextarea("    9) Ninth step");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    9) Ninth step\n    10) ");
});

test("continues list with Enter on mobile", () => {
  const ta = createMockTextarea("    • Mobile item");
  const result = simulateKey(ta, "Enter", { shiftKey: false, mobile: true });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • Mobile item\n    • ");
  assert.equal(ta.value, "    • Mobile item\n    • ");
});

test("desktop Enter without Shift does not continue list (lets composer submit)", () => {
  const ta = createMockTextarea("    • Item 1");
  const result = simulateKey(ta, "Enter", { shiftKey: false, mobile: false });
  assert.equal(result.handled, false);
  assert.equal(result.defaultPrevented, false);
  assert.equal(result.text, "    • Item 1");
});

test("preserves existing deep indentation on continued list item", () => {
  const ta = createMockTextarea("        • Deeply nested item");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "        • Deeply nested item\n        • ");
});

test("continues task list with an unchecked box", () => {
  const ta = createMockTextarea("    • [x] Done item");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    • [x] Done item\n    • [ ] ");
});

test("exits list when newline is pressed on an empty list item", () => {
  const ta = createMockTextarea("    • Item 1\n    • ");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • Item 1\n");
  assert.equal(ta.value, "    • Item 1\n");
  assert.equal(ta.selectionStart, 13);
});

test("exits numbered list when Enter is pressed on empty numbered item on mobile", () => {
  const ta = createMockTextarea("    1. First\n    2. ");
  const result = simulateKey(ta, "Enter", { shiftKey: false, mobile: true });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    1. First\n");
  assert.equal(ta.value, "    1. First\n");
  assert.equal(ta.selectionStart, 13);
});

test("Backspace removes empty list marker in one stroke", () => {
  const ta = createMockTextarea("    • Item 1\n    • ", 19);
  const result = simulateKey(ta, "Backspace");
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • Item 1\n");
  assert.equal(ta.value, "    • Item 1\n");
  assert.equal(ta.selectionStart, 13);
});

test("Backspace right after marker converts list item to plain text", () => {
  const ta = createMockTextarea("    • Hello world", 6);
  const result = simulateKey(ta, "Backspace");
  assert.equal(result.handled, true);
  assert.equal(result.text, "Hello world");
  assert.equal(ta.value, "Hello world");
  assert.equal(ta.selectionStart, 0);
});

test("does not intercept when text selection is active", () => {
  const ta = createMockTextarea("    • Item 1", 2, 6);
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, false);
});

test("does not intercept non-list lines", () => {
  const ta = createMockTextarea("Just regular text");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, false);
});

test("does not intercept during desktop IME composition or modifier keys", () => {
  const ta = createMockTextarea("    • Item 1");
  assert.equal(simulateKey(ta, "Enter", { shiftKey: true, isComposing: true, mobile: false }).handled, false);
  assert.equal(simulateKey(ta, "Enter", { shiftKey: true, ctrlKey: true }).handled, false);
  assert.equal(simulateKey(ta, "Enter", { shiftKey: true, metaKey: true }).handled, false);
});

test("mobile Enter continues list even when mobile virtual keyboard reports isComposing", () => {
  const ta = createMockTextarea("    • Mobile item");
  const result = simulateKey(ta, "Enter", { shiftKey: false, isComposing: true, mobile: true });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    • Mobile item\n    • ");
});

test("splits list item cleanly when newline is pressed mid-line", () => {
  const ta = createMockTextarea("    • First and second", 12); // after "First "
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    • First \n    • and second");
  assert.equal(ta.value, "    • First \n    • and second");
  assert.equal(ta.selectionStart, 19);
});

test("normalizeComposerLists converts bullet points to markdown dashes", () => {
  const input = "    • item 1\n    • item 2\n\n    1. step 1\n    2. step 2";
  const output = normalizeComposerLists(input);
  assert.equal(output, "- item 1\n- item 2\n\n1. step 1\n2. step 2");
});

test("normalizeComposerLists preserves nested list hierarchy", () => {
  const input = "    • Parent\n        • Child\n            • Grandchild\n\n    1. Step 1\n        1. Substep\n            1. Subsubstep";
  const output = normalizeComposerLists(input);
  assert.equal(output, "- Parent\n  - Child\n    - Grandchild\n\n1. Step 1\n  1. Substep\n    1. Subsubstep");
});

test("transformComposerInput converts dash and space to '    • '", () => {
  const res = transformComposerInput("- ", 2);
  assert.deepEqual(res, { value: "    • ", cursor: 6 });
});

test("transformComposerInput converts dash and item to '    • item'", () => {
  const res = transformComposerInput("- item", 6);
  assert.deepEqual(res, { value: "    • item", cursor: 10 });
});

test("transformComposerInput converts en-dash to '    • '", () => {
  const res = transformComposerInput("– ", 2);
  assert.deepEqual(res, { value: "    • ", cursor: 6 });
});

test("transformComposerInput converts '1. ' to '    1. '", () => {
  const res = transformComposerInput("1. ", 3);
  assert.deepEqual(res, { value: "    1. ", cursor: 7 });
});

test("hasComposerList detects bullet dots, dashes, en-dashes and numbered lists", () => {
  assert.equal(hasComposerList("hello world"), false);
  assert.equal(hasComposerList("• item"), true);
  assert.equal(hasComposerList("    • item"), true);
  assert.equal(hasComposerList("- item"), true);
  assert.equal(hasComposerList("– item"), true);
  assert.equal(hasComposerList("1. item"), true);
  assert.equal(hasComposerList("intro:\n    • item"), true);
});

test("pressing Enter on unindented dash list normalizes first item and continues with '    • '", () => {
  const ta = createMockTextarea("- item 1");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    • item 1\n    • ");
  assert.equal(ta.value, "    • item 1\n    • ");
  assert.equal(ta.selectionStart, 19);
  assert.equal(ta.scrollTop, ta.scrollHeight);
});

test("pressing Enter on unindented numbered list normalizes first item and continues with '    2. '", () => {
  const ta = createMockTextarea("1. step 1");
  const result = simulateKey(ta, "Enter", { shiftKey: true, mobile: false });
  assert.equal(result.handled, true);
  assert.equal(result.text, "    1. step 1\n    2. ");
  assert.equal(ta.value, "    1. step 1\n    2. ");
  assert.equal(ta.selectionStart, 21);
  assert.equal(ta.scrollTop, ta.scrollHeight);
});

test("handleComposerBeforeInput intercepts Space after dash to insert '    • '", () => {
  const ta = createMockTextarea("-");
  let reportedCursor: number | null = null;
  const result = simulateBeforeInput(ta, { data: " ", inputType: "insertText", mobile: true }, (c) => { reportedCursor = c; });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • ");
  assert.equal(ta.value, "    • ");
  assert.equal(ta.selectionStart, 6);
  assert.equal(reportedCursor, 6);
});

test("handleComposerBeforeInput intercepts Space after '1.' to insert '    1. '", () => {
  const ta = createMockTextarea("1.");
  let reportedCursor: number | null = null;
  const result = simulateBeforeInput(ta, { data: " ", inputType: "insertText", mobile: true }, (c) => { reportedCursor = c; });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    1. ");
  assert.equal(ta.value, "    1. ");
  assert.equal(ta.selectionStart, 7);
  assert.equal(reportedCursor, 7);
});

test("handleComposerBeforeInput intercepts insertParagraph on mobile to continue list", () => {
  const ta = createMockTextarea("    • First item");
  const result = simulateBeforeInput(ta, { inputType: "insertParagraph", mobile: true });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • First item\n    • ");
  assert.equal(ta.value, "    • First item\n    • ");
});

test("handleComposerBeforeInput exits list on empty item when Return is pressed", () => {
  const ta = createMockTextarea("    • First item\n    • ");
  const result = simulateBeforeInput(ta, { inputType: "insertParagraph", mobile: true });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • First item\n");
  assert.equal(ta.value, "    • First item\n");
});

test("handleComposerBeforeInput exits list on empty item when Backspace is pressed", () => {
  const ta = createMockTextarea("    • First item\n    • ", 23);
  const result = simulateBeforeInput(ta, { inputType: "deleteContentBackward", mobile: true });
  assert.equal(result.handled, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.text, "    • First item\n");
});

test("scrollTextareaToCursor scrolls to bottom when cursor is at the end", () => {
  const ta = createMockTextarea("Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6", 42);
  ta.clientHeight = 50;
  ta.scrollHeight = 140;
  ta.scrollTop = 0;
  scrollTextareaToCursor(ta);
  assert.equal(ta.scrollTop, 140);
});

test("scrollTextareaToCursor brings scrolled-out top line into view", () => {
  const ta = createMockTextarea("Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6", 2); // on Line 1
  ta.clientHeight = 50;
  ta.scrollHeight = 140;
  ta.scrollTop = 90;
  scrollTextareaToCursor(ta);
  assert.equal(ta.scrollTop, 0);
});

