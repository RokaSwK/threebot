import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, RefreshCw } from "lucide-react";
import { Pill, Spinner } from "./ui";
import { RichMarkdown } from "./RichMarkdown";
import { InstructionsEditor } from "./InstructionsEditor";
import { openDialog, toast, useApp } from "../store";
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
    setError("");
    setConflict(null);
    setSaved(false);
    setSaving(false);
    setConfirmDiscard(false);
    void load();
    const timer = setInterval(() => { if (!editingRef.current && document.visibilityState === "visible") void load(true); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const start = () => {
    if (!file) return;
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

  return (
    <>
      <div className="instructions-pane">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="pane-title instructions-title text-[18px] font-medium">Instructions</h2>
          <Pill variant="soft" className="instructions-edit-button ml-auto" onClick={start}>
            <Pencil size={13} /> {hasInstructions ? "Edit" : "Write"}
          </Pill>
          <Pill variant="soft" className="instructions-refresh h-8" onClick={() => void load()} aria-label="Refresh instructions" title="Refresh"><RefreshCw size={13} /></Pill>
        </div>
        <p className="instructions-intro mb-4 text-[12.5px] leading-relaxed text-muted">How {bot.name} should work, in your words. Every new session reads this.</p>

        <section className="instructions-section" aria-label="Standing instructions">

          {error && <div role="alert" className="mb-3 rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't refresh instructions: {error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></div>}

          {hasInstructions ? (
            <div className="instructions-preview memory-view md rounded-xl border border-line bg-card px-3.5 py-3 text-[13.5px] leading-[21px] break-words"><RichMarkdown>{file.text}</RichMarkdown></div>
          ) : (
            <div className="instructions-empty rounded-xl border border-dashed border-line px-4 py-4 text-[13px] leading-relaxed text-muted">
              <p className="text-fg">No instructions yet.</p>
              <p className="mt-1 mb-3">Say what {bot.name} is for, what it shouldn't do, and how it talks. For example:</p>
              <pre className="instructions-example whitespace-pre-wrap font-mono text-[12.5px] leading-[19px] text-muted">{INSTRUCTIONS_EXAMPLE}</pre>
            </div>
          )}

          <p className="instructions-section-meta mt-2">{file.path} · {words(file.text).toLocaleString()} words</p>
          {saved && <p role="status" className="instructions-saved mt-2 text-[12px] text-muted">Saved. The next session will read it.</p>}
        </section>

        <p className="instructions-how text-[12px] leading-relaxed text-muted">
          This adds to what Threebot already tells every Bot. It can't turn off the Vault or the rules in <button type="button" className="text-fg underline underline-offset-2" onClick={() => { useApp.setState({ settingsPane: "permissions" }); openDialog("settings"); }}>Settings › Permissions</button>. To apply a change in the current chat, send <span className="font-mono">/clear</span>. No passwords or keys here; use the Vault.
        </p>
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
