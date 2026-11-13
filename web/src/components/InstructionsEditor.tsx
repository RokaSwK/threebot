import { useRef, useState } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Modal, Pill } from "./ui";
import { RichMarkdown } from "./RichMarkdown";
import type { Bot } from "../lib/types";
import type { InstructionFile } from "../lib/instructions";

type View = "write" | "preview";

/**
 * The focused editor for the owner's part of AGENTS.md. It lives outside the narrow Details panel
 * on desktop and takes the whole sheet on a phone, so a long document is not edited through a
 * 280px keyhole. The tab owns loading, revisions and conflicts; this component only collects the
 * draft and makes the save/discard decisions visible.
 */
export function InstructionsEditor({
  bot, file, draft, onDraft, totalBytes, tooLong, overWarn, lengthError,
  unchanged, saving, conflict, error, confirmDiscard, onSave, onOverwrite, onUseTheirs,
  onRequestClose, onCancel, onKeepEditing,
}: {
  bot: Bot;
  file: InstructionFile;
  draft: string;
  onDraft: (text: string) => void;
  totalBytes: number;
  tooLong: boolean;
  overWarn: boolean;
  lengthError: string;
  unchanged: boolean;
  saving: boolean;
  conflict: { revision: string; text: string } | null;
  error: string;
  confirmDiscard: boolean;
  onSave: () => void;
  onOverwrite: () => void;
  onUseTheirs: () => void;
  onRequestClose: () => void;
  onCancel: () => void;
  onKeepEditing: () => void;
}) {
  const [view, setView] = useState<View>("write");
  const editor = useRef<HTMLTextAreaElement>(null);

  return <Modal
    onClose={onRequestClose}
    title={<span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate">Editing instructions</span><span className="truncate text-[12px] font-normal text-muted">· {bot.name}</span></span>}
    className="instructions-editor"
  >
    <div className="instructions-editor-shell" data-view={view}>
      <div className="instructions-editor-toolbar">
        <span className="instructions-editor-toolbar-title">Owner's part · {file.path}</span>
        <div className="instructions-editor-view" role="group" aria-label="Editor view">
          <button type="button" aria-pressed={view === "write"} onClick={() => { setView("write"); editor.current?.focus(); }}>Write</button>
          <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</button>
        </div>
        <span className="instructions-editor-shortcut">Ctrl/⌘S to save</span>
      </div>

      <div className="instructions-editor-grid">
        <section className="instructions-editor-pane instructions-editor-write" aria-label="Markdown editor">
          <div className="instructions-editor-pane-head">
            <span>Markdown</span>
            <span>{draft.length.toLocaleString()} / {file.maxChars.toLocaleString()}</span>
          </div>
          <textarea
            ref={editor}
            aria-label="Edit instructions"
            aria-describedby="instructions-editor-hint"
            className="instructions-editor-textarea"
            value={draft}
            autoFocus
            spellCheck
            placeholder="Say what this Bot is for, what it owns, and how it should work."
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "Enter")) {
                event.preventDefault();
                if (!tooLong && !saving && !conflict) onSave();
              }
            }}
          />
        </section>

        <section className="instructions-editor-pane instructions-editor-preview" aria-label="Preview">
          <div className="instructions-editor-pane-head">
            <span>Preview</span>
            <span>How {bot.name} reads it</span>
          </div>
          <div className="instructions-editor-preview-body memory-view md">
            {draft.trim()
              ? <RichMarkdown>{draft}</RichMarkdown>
              : <p className="text-[13px] text-muted">Nothing yet. The preview appears as you write.</p>}
          </div>
        </section>
      </div>

      <p id="instructions-editor-hint" className="instructions-editor-hint">
        <ShieldCheck size={12} aria-hidden="true" /> No passwords, keys or tokens here; use the Vault.
      </p>

      {error && <p role="alert" className="instructions-editor-alert text-danger">Couldn't refresh instructions: {error}</p>}
      {lengthError && <p role="alert" className="instructions-editor-alert text-danger">{lengthError}</p>}
      {overWarn && !tooLong && <p className="instructions-editor-alert text-attention"><TriangleAlert size={12} className="mr-1 inline-block align-[-2px]" aria-hidden="true" />Some models may cut a file this long. Consider tightening it.</p>}

      {conflict && <div role="alert" className="instructions-editor-conflict">
        {bot.name} changed these instructions while you were editing.
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill variant="soft" className="h-9 px-3 text-[12.5px]" disabled={saving} onClick={onOverwrite}>Save mine over it</Pill>
          <Pill variant="soft" className="h-9 px-3 text-[12.5px]" onClick={onUseTheirs}>Load theirs</Pill>
        </div>
      </div>}

      {confirmDiscard && <div role="alertdialog" aria-label="Discard changes?" className="instructions-editor-confirm">
        <span>Discard unsaved changes?</span>
        <div className="ml-auto flex shrink-0 gap-2">
          <Pill variant="soft" className="h-9 px-3 text-[12.5px]" autoFocus onClick={onKeepEditing}>Keep editing</Pill>
          <Pill variant="danger" className="h-9 px-3 text-[12.5px]" onClick={onCancel}>Discard</Pill>
        </div>
      </div>}

      <div className="instructions-editor-footer">
        <div className="instructions-editor-meta">
          <span>{draft.length.toLocaleString()} / {file.maxChars.toLocaleString()} characters</span>
          <span aria-hidden="true">·</span>
          <span className={overWarn ? "text-attention" : undefined}>{formatBytes(totalBytes)} total / {formatBytes(file.maxTotalBytes)} max</span>
        </div>
        <div className="instructions-editor-actions">
          <Pill variant="soft" className="instructions-editor-cancel" onClick={onRequestClose}>Cancel</Pill>
          <Pill className="instructions-editor-save" disabled={saving || tooLong || unchanged || Boolean(conflict)} onClick={onSave}>{saving ? "Saving…" : "Save"}</Pill>
        </div>
      </div>
    </div>
  </Modal>;
}

const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
