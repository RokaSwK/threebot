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
    if (out.length && (/^([-*]|\d+\.)\s/.test(p) || /:$/.test(out[out.length - 1]))) out[out.length - 1] += "\n\n" + p;
    else out.push(p);
  }
  return out.length > 4 ? [text] : out;
}

/** `/clear` on its own starts a fresh session with the next message, as in T3 Code. */
export function isClearCommand(text: string) {
  return /^\/clear\s*$/i.test(text.trim());
}
