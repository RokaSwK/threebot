import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, ChevronRight, Pencil, RefreshCw, X } from "lucide-react";
import { Pill, Spinner } from "./ui";
import { RichMarkdown } from "./RichMarkdown";
import { InstructionsEditor } from "./InstructionsEditor";
import { openDialog, toast, updateBot, useApp } from "../store";
import { registerBackGuard } from "../lib/backGuard";
import { INSTRUCTIONS_EXAMPLE, instructionsApi, type InstructionFile } from "../lib/instructions";
import type { Bot } from "../lib/types";

// While no one is editing, the tab picks up the Bot's own edits on this beat.
const REFRESH_MS = 5_000;

const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

const words = (text: string) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
};

/** Details › Instructions: the owner's part of AGENTS.md, as Markdown that both of you edit. */
export function InstructionsTab({ bot }: { bot: Bot }) {
  const [file, setFile] = useState<InstructionFile | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // A reply for a Bot that is no longer shown must not land under the one that is.
  const shownSlug = useRef(bot.slug);
  shownSlug.current = bot.slug;
  const requestId = useRef(0);
  // A slow poll must not overwrite the file the save just reloaded.
  const loadId = useRef(0);
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState("");
  const [conflict, setConflict] = useState<{ revision: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestCloseRef = useRef<() => void>(() => {});
  const [labelDraft, setLabelDraft] = useState(bot.label ?? "");
  const [editingLabel, setEditingLabel] = useState(false);
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelSaved, setLabelSaved] = useState(false);

  const load = useCallback(async (quiet = false) => {
    const slug = bot.slug;
    const id = ++loadId.current;
    try {
      const next = await instructionsApi.get(slug);
      if (shownSlug.current !== slug || id !== loadId.current) return;
      setFile(next);
      setError("");
      if (!editingRef.current) {
        setDraft(next.text);
        setBase(next.revision);
      }
    } catch (cause) {
      if (!quiet && shownSlug.current === slug) setError(cause instanceof Error ? cause.message : "Couldn't load instructions");
    }
  }, [bot.slug]);

  useEffect(() => {
    requestId.current++;
    loadId.current++;
    setFile(null);
    setEditing(false);
    setEditingLabel(false);
    setError("");
    setConflict(null);
    setSaved(false);
    setSaving(false);
    setSavingLabel(false);
    setConfirmDiscard(false);
    setLabelSaved(false);
    void load();
    const timer = setInterval(() => { if (!editingRef.current && document.visibilityState === "visible") void load(true); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A role save changes bot.label; it must not tear down the tab or close an editor.
  useEffect(() => {
    if (!editingLabel) setLabelDraft(bot.label ?? "");
  }, [bot.label, editingLabel]);

  useEffect(() => {
    if (!labelSaved) return;
    const timer = window.setTimeout(() => setLabelSaved(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [labelSaved]);

  const start = () => {
    if (!file || editingLabel) return;
    setDraft(file.text);
    setBase(file.revision);
    setConflict(null);
    setConfirmDiscard(false);
    setSaved(false);
    setEditing(true);
  };

  const cancel = () => {
    setConflict(null);
    setConfirmDiscard(false);
    setEditing(false);
    if (file) {
      setDraft(file.text);
      setBase(file.revision);
    }
  };

  const requestClose = () => {
    if (saving) return;
    if (!file || draft !== file.text || conflict) {
      setConfirmDiscard(true);
      return;
    }
    cancel();
  };
  requestCloseRef.current = requestClose;

  // Browser/Android Back closes this surface before it pops the Details sheet underneath.
  useEffect(() => {
    if (!editing) return;
    return registerBackGuard(() => {
      requestCloseRef.current();
      return true;
    });
  }, [editing]);

  const save = async (revision = base) => {
    if (saving || !file || (conflict && revision === base)) return;
    const id = ++requestId.current;
    const slug = bot.slug;
    setSaving(true);
    try {
      const result = await instructionsApi.save({ slug, text: draft, expectedRevision: revision });
      if (shownSlug.current !== slug || id !== requestId.current) return;
      if (result.ok) {
        setConflict(null);
        setConfirmDiscard(false);
        setEditing(false);
        setBase(result.revision);
        setSaved(true);
        toast("Instructions saved");
        await load(true);
        return;
      }
      if (result.code === "conflict") {
        setConflict({ revision: result.revision, text: result.text });
        return;
      }
      toast(result.message);
    } catch (cause) {
      if (shownSlug.current === slug && id === requestId.current) toast(cause instanceof Error ? cause.message : "Couldn't save instructions");
    } finally {
      if (id === requestId.current) setSaving(false);
    }
  };

  const useTheirs = () => {
    if (!conflict) return;
    setDraft(conflict.text);
    setBase(conflict.revision);
    setConflict(null);
    setConfirmDiscard(false);
  };

  const startLabel = () => {
    if (editing) return;
    setLabelDraft(bot.label ?? "");
    setLabelSaved(false);
    setEditingLabel(true);
  };

  const cancelLabel = () => {
    setLabelDraft(bot.label ?? "");
    setEditingLabel(false);
  };

  const saveLabel = async () => {
    if (savingLabel) return;
    const value = labelDraft.trim();
    if (value === (bot.label ?? "")) { setEditingLabel(false); return; }
    const slug = bot.slug;
    setSavingLabel(true);
    try {
      await updateBot(slug, { label: value });
      if (shownSlug.current === slug) {
        setEditingLabel(false);
        setLabelSaved(true);
      }
    } catch (cause) {
      if (shownSlug.current === slug) toast(cause instanceof Error ? cause.message : "Couldn't save the role");
    } finally {
      if (shownSlug.current === slug) setSavingLabel(false);
    }
  };

  if (!file && !error) return <div className="grid h-32 place-items-center text-muted"><Spinner /></div>;
  if (!file) return <div role="alert" className="rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't load instructions: {error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></div>;

  const bytes = new TextEncoder().encode(draft).length;
  const totalBytes = Math.max(0, file.totalBytes - file.bytes + bytes);
  const tooManyChars = draft.length > file.maxChars;
  const tooManyBytes = totalBytes > file.maxTotalBytes;
  const tooLong = tooManyChars || tooManyBytes;
  const overWarn = totalBytes > file.warnAt;
  const unchanged = draft === file.text && !conflict;
  const lengthError = tooManyChars
    ? `Too long. Shorten it to ${file.maxChars.toLocaleString()} characters or fewer.`
    : tooManyBytes
      ? `The file would be ${formatBytes(totalBytes)}; the limit is ${formatBytes(file.maxTotalBytes)}.`
      : "";
  const hasInstructions = file.text.trim().length > 0;
  const role = bot.label?.trim() || "Add a one-line role";

  return (
    <>
      <div className="instructions-pane">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="pane-title instructions-title text-[18px] font-medium">Instructions</h2>
          <Pill variant="soft" className="ml-auto h-8" onClick={() => void load()} aria-label="Refresh instructions" title="Refresh"><RefreshCw size={13} /></Pill>
        </div>
        <p className="instructions-intro mb-5 text-[12.5px] leading-relaxed text-muted">How {bot.name} should work. Read at the start of every session, after Threebot's automatic manual.</p>

        <section className="instructions-section instructions-role-section" aria-labelledby="instructions-role-heading">
          <div className="instructions-section-head">
            <h3 id="instructions-role-heading" className="instructions-section-title">Role</h3>
            {labelSaved && <span role="status" className="instructions-saved-label"><Check size={12} aria-hidden="true" /> Saved</span>}
          </div>
          {editingLabel ? (
            <div className="instructions-role-editor">
              <input
                autoFocus
                aria-label="One-line role"
                enterKeyHint="done"
                value={labelDraft}
                onChange={(event) => setLabelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void saveLabel(); }
                  if (event.key === "Escape") { event.preventDefault(); cancelLabel(); }
                }}
                className="instructions-role-input"
                placeholder="A few words on its job"
              />
              <div className="instructions-role-actions">
                <button type="button" aria-label="Save role" title="Save role" disabled={savingLabel} onClick={() => void saveLabel()} className="instructions-role-action">
                  {savingLabel ? <span className="text-[11px]">…</span> : <Check size={15} />}
                </button>
                <button type="button" aria-label="Cancel role" title="Cancel role" onClick={cancelLabel} className="instructions-role-action">
                  <X size={15} />
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={startLabel} className="instructions-role-button" aria-label="Edit role">
              <span className={clsx("min-w-0 flex-1 truncate", !bot.label && "text-muted")}>{role}</span>
              <Pencil size={14} className="shrink-0 text-muted" aria-hidden="true" />
            </button>
          )}
          <p className="instructions-section-hint">Shown under the Bot's name.</p>
        </section>

        <section className="instructions-section instructions-body-section" aria-labelledby="instructions-body-heading">
          <div className="instructions-section-head">
            <div className="min-w-0">
              <h3 id="instructions-body-heading" className="instructions-section-title">Instructions</h3>
              <div className="instructions-section-meta">{file.path} · {words(file.text).toLocaleString()} words</div>
            </div>
            <Pill variant="soft" className="instructions-edit-button" disabled={editingLabel} title={editingLabel ? "Save or cancel the role first" : undefined} onClick={start}>
              <Pencil size={13} /> {hasInstructions ? "Edit instructions" : "Write instructions"}
            </Pill>
          </div>

          {error && <div role="alert" className="mb-3 rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't refresh instructions: {error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></div>}

          {hasInstructions ? (
            <div className="instructions-preview memory-view md rounded-xl border border-line bg-card px-3.5 py-3 text-[13.5px] leading-[21px] break-words"><RichMarkdown>{file.text}</RichMarkdown></div>
          ) : (
            <div className="instructions-empty rounded-xl border border-dashed border-line px-4 py-4 text-[13px] leading-relaxed text-muted">
              <p className="text-fg">No instructions yet.</p>
              <p className="mt-1 mb-3">Say what {bot.name} is for, what it owns, and how it should work.</p>
              <pre className="instructions-example whitespace-pre-wrap font-mono text-[12.5px] leading-[19px] text-muted">{INSTRUCTIONS_EXAMPLE}</pre>
            </div>
          )}

          {saved && <p role="status" className="instructions-saved mt-2 text-[12px] text-muted">Saved. The next session will read it.</p>}
        </section>

        <details className="instructions-how">
          <summary>
            <span>How this works</span>
            <ChevronRight size={14} className="instructions-how-chevron" aria-hidden="true" />
          </summary>
          <div className="instructions-how-body">
            <p>What you write here adds to Threebot's automatic manual. It can set limits and style, but it can't override the Vault or security rules. For a rule that must always apply, use <button type="button" className="text-fg underline underline-offset-2" onClick={() => { useApp.setState({ settingsPane: "permissions" }); openDialog("settings"); }}>Settings › Permissions</button>.</p>
            <p>New sessions read this when they start. In the current chat, use <span className="font-mono">/clear</span> to apply it now. Never put passwords, keys or tokens here; use the Vault.</p>
            <p><span className="text-fg">What Threebot writes automatically:</span> Identity, how to talk, memory, visuals, library, routines, threads, machines, projects, other Bots, connected apps, computer, Vault and independence. Those sections are generated and updated by Threebot; edits there are overwritten.</p>
            <p className="instructions-how-path">{file.path} · {formatBytes(file.totalBytes)} total. The managed part is not loaded into this tab.</p>
          </div>
        </details>
      </div>

      {editing && <InstructionsEditor
        bot={bot}
        file={file}
        draft={draft}
        onDraft={setDraft}
        totalBytes={totalBytes}
        tooLong={tooLong}
        overWarn={overWarn}
        lengthError={lengthError}
        unchanged={unchanged}
        saving={saving}
        conflict={conflict}
        error={error}
        confirmDiscard={confirmDiscard}
        onSave={() => void save()}
        onOverwrite={() => { if (conflict) void save(conflict.revision); }}
        onUseTheirs={useTheirs}
        onRequestClose={requestClose}
        onCancel={cancel}
        onKeepEditing={() => setConfirmDiscard(false)}
      />}
    </>
  );
}
