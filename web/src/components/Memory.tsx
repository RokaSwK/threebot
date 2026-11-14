import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, RefreshCw, Sparkles } from "lucide-react";
import { Pill, Spinner } from "./ui";
import { RichMarkdown } from "./RichMarkdown";
import { selectThread, setDetailsOpen, toast } from "../store";
import { chatDraft } from "../lib/chatDrafts";
import { memoryApi, type MemoryFile, type MemoryFiles, type MemoryScope } from "../lib/memory";
import type { Bot } from "../lib/types";

// While no one is editing, the tab picks up the Bot's own edits on this beat.
const REFRESH_MS = 5_000;

/** Details › Memory: the Bot's memory file and the shared one, as Markdown that both of you edit. */
export function MemoryTab({ bot }: { bot: Bot }) {
  const [files, setFiles] = useState<MemoryFiles | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryScope | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // A reply for a Bot that is no longer shown must not land under the one that is.
  const shownSlug = useRef(bot.slug);
  shownSlug.current = bot.slug;

  const load = useCallback(async (quiet = false) => {
    const slug = bot.slug;
    try {
      const next = await memoryApi.get(slug);
      if (shownSlug.current !== slug) return;
      setFiles(next);
      setError("");
    } catch (cause) {
      if (!quiet && shownSlug.current === slug) setError(cause instanceof Error ? cause.message : "Couldn't load memory");
    }
  }, [bot.slug]);

  useEffect(() => {
    setFiles(null);
    setEditing(null);
    setError("");
    void load();
    const timer = setInterval(() => { if (!editingRef.current && document.visibilityState === "visible") void load(true); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const tidy = () => {
    if (!bot.mainThreadId) { toast("This Bot has no main conversation yet."); return; }
    const draft = chatDraft(bot, bot.mainThreadId);
    draft.setText([draft.getSnapshot().text, "Tidy your memory file: merge duplicates, group related lines under headings, and remove anything stale or contradictory. Tell me what you changed."].filter(Boolean).join("\n\n"));
    selectThread(bot, bot.mainThreadId);
    setDetailsOpen(false);
  };

  if (!files && !error) return <div className="grid h-32 place-items-center text-muted"><Spinner /></div>;
  if (!files) return <div role="alert" className="rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't load memory: {error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></div>;

  return (
    <div className="memory-pane">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="pane-title text-[18px] font-medium">Memory</h2>
        <Pill variant="soft" onClick={() => void load()} className="ml-auto h-8" aria-label="Refresh memory" title="Refresh"><RefreshCw size={13} /></Pill>
      </div>
      <p className="mb-4 text-[12.5px] leading-relaxed text-muted">What {bot.name} remembers between sessions. It edits these files as it learns, and so can you. New sessions start with them.</p>
      {error && <div role="alert" className="mb-3 rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't refresh memory: {error}</div>}

      <MemoryFileCard
        key={`${bot.slug}:bot`}
        title={bot.name}
        file={files.bot}
        empty={`Nothing yet. ${bot.name} adds things here as it learns them, or write them yourself.`}
        editing={editing === "bot"}
        locked={editing === "shared"}
        onEdit={(on) => setEditing(on ? "bot" : null)}
        onSave={(text, expectedRevision) => memoryApi.save({ slug: bot.slug, scope: "bot", text, expectedRevision })}
        onSaved={() => void load(true)}
        botName={bot.name}
      />
      <MemoryFileCard
        key={`${bot.slug}:shared`}
        title="Shared by all Bots"
        file={files.shared}
        empty="Nothing shared yet. Facts every Bot should know go here: your name, time zone, key people."
        editing={editing === "shared"}
        locked={editing === "bot"}
        onEdit={(on) => setEditing(on ? "shared" : null)}
        onSave={(text, expectedRevision) => memoryApi.save({ slug: bot.slug, scope: "shared", text, expectedRevision })}
        onSaved={() => void load(true)}
        botName={bot.name}
      />

      <Pill variant="soft" className="mt-1" onClick={tidy}><Sparkles size={13} /> Ask {bot.name} to tidy</Pill>
    </div>
  );
}

function MemoryFileCard({ title, file, empty, editing, locked, onEdit, onSave, onSaved, botName }: {
  title: string;
  file: MemoryFile;
  empty: string;
  editing: boolean;
  /** The other file is open in the editor; one draft at a time, so neither is lost. */
  locked: boolean;
  onEdit: (on: boolean) => void;
  onSave: (text: string, expectedRevision: string) => ReturnType<typeof memoryApi.save>;
  onSaved: () => void;
  botName: string;
}) {
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState(file.revision);
  const [conflict, setConflict] = useState<{ revision: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const start = () => { setDraft(file.text); setBase(file.revision); setConflict(null); onEdit(true); };
  const cancel = () => { setConflict(null); onEdit(false); };
  const save = async (revision = base) => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await onSave(draft, revision);
      if (result.ok) { setConflict(null); onEdit(false); onSaved(); toast("Memory saved"); return; }
      setConflict({ revision: result.revision, text: result.text });
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Couldn't save memory");
    } finally {
      setSaving(false);
    }
  };
  const useTheirs = () => { if (!conflict) return; setDraft(conflict.text); setBase(conflict.revision); setConflict(null); };

  return <section className="mb-5" aria-label={title}>
    <div className="mb-1.5 flex items-center gap-2 px-1">
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{title} · <span className="font-mono text-[11.5px]">{file.path}</span></span>
      {!editing && <Pill variant="soft" className="h-7 px-2.5 text-[12px]" disabled={locked} title={locked ? "Save or cancel the other file first" : undefined} onClick={start}><Pencil size={12} /> Edit</Pill>}
    </div>
    {editing ? <div className="rounded-xl border border-line bg-card p-2">
      <textarea
        aria-label={`Edit ${title} memory`}
        className="memory-editor block w-full resize-y rounded-lg bg-transparent p-2 font-mono text-[12.5px] leading-[20px] outline-none"
        value={draft}
        rows={Math.min(24, Math.max(8, draft.split("\n").length + 1))}
        autoFocus
        spellCheck
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "Enter")) { event.preventDefault(); void save(); }
        }}
      />
      {conflict && <div role="alert" className="mx-1 mt-2 rounded-lg border border-line bg-elevated p-2.5 text-[12.5px]">
        {botName} changed this file while you were editing.
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill variant="soft" className="h-7 text-[12px]" disabled={saving} onClick={() => void save(conflict.revision)}>Save mine over it</Pill>
          <Pill variant="soft" className="h-7 text-[12px]" onClick={useTheirs}>Load theirs</Pill>
        </div>
      </div>}
      <div className="mt-2 flex items-center gap-2 px-1">
        <span className="mr-auto text-[11.5px] text-muted">Markdown · ⌘S to save</span>
        <Pill variant="soft" className="h-7 text-[12px]" onClick={cancel}>Cancel</Pill>
        <Pill className="h-7 text-[12px]" disabled={saving || draft === file.text && !conflict} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Pill>
      </div>
    </div> : file.text.trim()
      ? <div className="memory-view md rounded-xl border border-line bg-card px-3.5 py-3 text-[13.5px] leading-[21px] break-words"><RichMarkdown>{file.text}</RichMarkdown></div>
      : <button type="button" onClick={start} disabled={locked} className="w-full rounded-xl border border-dashed border-line px-3 py-2.5 text-left text-[12.5px] text-muted hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent">{empty}</button>}
  </section>;
}
