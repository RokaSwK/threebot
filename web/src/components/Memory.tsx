import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Brain, ChevronRight, FileText, RefreshCw, Scissors, Sparkles, Trash2 } from "lucide-react";
import { Modal, Pill, Spinner } from "./ui";
import { toast } from "../store";
import { chatDraft } from "../lib/chatDrafts";
import { selectThread, setDetailsOpen } from "../store";
import { memoryApi, type DefragReport, type MemoryFact, type MemoryNote, type MemoryView } from "../lib/memory";
import type { Bot } from "../lib/types";

type ShownFact = MemoryFact & { scope: "bot" | "shared" };

/** Details › Memory: what this Bot remembers, where it came from, and what to remove. */
export function MemoryTab({ bot }: { bot: Bot }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ShownFact | null>(null);
  const [note, setNote] = useState<{ path: string; text: string; revision: string } | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [defrag, setDefrag] = useState<DefragReport | null>(null);
  const [auditing, setAuditing] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setView(await memoryApi.get(bot.slug));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load memory");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setView(null);
    setSelected(null);
    setNote(null);
    setLoading(true);
    setError("");
    memoryApi.get(bot.slug)
      .then((next) => { if (active) setView(next); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Couldn't load memory"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bot.slug]);

  const facts = useMemo<ShownFact[]>(() => view
    ? [...view.bot.facts.map((fact) => ({ ...fact, scope: "bot" as const })), ...view.shared.facts.map((fact) => ({ ...fact, scope: "shared" as const }))]
    : [], [view]);
  const duplicates = useMemo(() => facts.length - new Set(facts.map((fact) => fact.text.toLowerCase())).size, [facts]);
  const largeNotes = useMemo(() => view ? view.notes.filter((entry) => entry.tokens >= view.limits.noteTokens || entry.chars >= view.limits.noteChars).length : 0, [view]);

  const forget = async () => {
    if (!selected || !view || forgetting) return;
    if (!window.confirm(`Forget “${selected.text}”? This writes a tombstone so reflection cannot bring it back.`)) return;
    setForgetting(true);
    try {
      const result = await memoryApi.forget({
        slug: bot.slug,
        scope: selected.scope,
        fact: selected.line,
        expectedRevision: selected.scope === "shared" ? view.shared.revision : view.bot.revision,
      });
      if (!result.ok) { toast(result.message); return; }
      setSelected(null);
      await load();
      toast("Forgotten");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Couldn't forget that fact");
    } finally {
      setForgetting(false);
    }
  };

  const audit = async (options: { applySafe?: boolean; retireClosed?: boolean } = {}) => {
    if (auditing) return;
    setAuditing(true);
    try {
      const result = await memoryApi.defrag(bot.slug, options);
      setDefrag(result.report);
      if ((options.applySafe && result.dedupe?.removed) || (options.retireClosed && result.retired?.removed)) await load();
      if (options.retireClosed && result.retired) toast(`Retired ${result.retired.removed} closed fact(s)`);
      else if (options.applySafe && result.dedupe) toast(`Removed ${result.dedupe.removed} exact duplicate line(s)`);
      else toast("Memory audit written");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Couldn't audit memory");
    } finally {
      setAuditing(false);
    }
  };

  const tidy = () => {
    if (!bot.mainThreadId) { toast("This Bot has no main conversation yet."); return; }
    const draft = chatDraft(bot, bot.mainThreadId);
    draft.setText([draft.getSnapshot().text, "Tidy your memory: look for duplicate facts, stale or contradictory entries, and notes that are too large. Propose the changes with memory_edit; don't delete anything without asking me."].filter(Boolean).join("\n\n"));
    selectThread(bot, bot.mainThreadId);
    setDetailsOpen(false);
  };

  const openNote = async (entry: MemoryNote) => {
    try {
      const loaded = await memoryApi.note(bot.slug, entry.path);
      setNote({ path: loaded.path, text: loaded.text, revision: loaded.revision });
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Couldn't read that note");
    }
  };

  const splitNote = async () => {
    if (!note) return;
    try {
      const result = await memoryApi.splitNote({ slug: bot.slug, path: note.path, expectedRevision: note.revision });
      if (!result.ok) { toast(result.message); return; }
      setNote(null);
      await load();
      toast(`Split into ${result.parts?.length ?? 0} notes`);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Couldn't split that note");
    }
  };

  if (loading && !view) return <div className="grid h-32 place-items-center text-muted"><Spinner /></div>;
  if (error && !view) return <div role="alert" className="rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't load memory: {error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></div>;

  return (
    <div className="memory-pane">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[18px] font-medium">Memory</h2>
        <Pill variant="soft" onClick={() => void load()} className="ml-auto h-8" aria-label="Refresh memory"><RefreshCw size={13} /></Pill>
      </div>
      <p className="mb-4 text-[12.5px] leading-relaxed text-muted">What {bot.name} remembers between sessions. Facts marked “shared” are visible to every Bot.</p>

      {error && <div role="alert" className="mb-3 rounded-xl border border-line p-3 text-[13px] text-danger">Couldn't load memory: {error}</div>}

      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat value={facts.length} label="facts" />
        <Stat value={view?.notes.length ?? 0} label="notes" />
        <Stat value={view?.forgotten ?? 0} label="forgotten" />
      </div>

      <Section title="Shared by all Bots" empty={!view?.shared.facts.length ? "No shared facts yet." : null}>
        {view?.shared.facts.map((fact, index) => <FactRow key={`${fact.hash}:${index}`} fact={{ ...fact, scope: "shared" }} onOpen={() => setSelected({ ...fact, scope: "shared" })} />)}
      </Section>

      <Section title={`${bot.name} only`} empty={!view?.bot.facts.length ? "Nothing saved yet. Ask the Bot to remember something." : null}>
        {view?.bot.facts.map((fact, index) => <FactRow key={`${fact.hash}:${index}`} fact={{ ...fact, scope: "bot" }} onOpen={() => setSelected({ ...fact, scope: "bot" })} />)}
      </Section>

      <Section title="Notes" empty={!view?.notes.length ? "No notes yet." : null}>
        {view?.notes.map((entry) => (
          <button key={entry.path} onClick={() => void openNote(entry)} className="flex w-full items-center gap-2 border-b border-line px-1 py-2.5 text-left last:border-0 hover:bg-hover">
            <FileText size={14} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px]">{entry.description}</span><span className="block truncate text-[11.5px] text-muted">{entry.path} · {entry.tokens} tokens</span></span>
            <ChevronRight size={14} className="shrink-0 text-muted" />
          </button>
        ))}
      </Section>

      <div className="mt-5 rounded-2xl border border-line bg-card px-3.5 py-3">
        <div className="flex items-center gap-2 text-[13px]"><Sparkles size={14} className="text-muted" /><span className="font-medium">Tidy</span></div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          {duplicates || largeNotes
            ? [duplicates ? `${duplicates} possible duplicate${duplicates === 1 ? "" : "s"}` : "", largeNotes ? `${largeNotes} note${largeNotes === 1 ? "" : "s"} over the size budget` : ""].filter(Boolean).join(" · ")
            : "No duplicates or oversized notes found."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Pill variant="soft" disabled={auditing} onClick={() => void audit()}><RefreshCw size={13} /> {auditing ? "Auditing…" : "Audit memory"}</Pill>
          {defrag && defrag.counts.exactDuplicateFacts > 0 && <Pill variant="soft" disabled={auditing} onClick={() => void audit({ applySafe: true })}>Remove exact duplicates</Pill>}
          {defrag && defrag.counts.staleFacts > 0 && <Pill variant="soft" disabled={auditing} onClick={() => void audit({ retireClosed: true })}>Retire closed facts</Pill>}
          <Pill variant="soft" onClick={tidy}><Sparkles size={13} /> Ask {bot.name} to tidy</Pill>
        </div>
        {defrag && <div className="mt-2 text-[12px] leading-relaxed text-muted">
          {defrag.findings.length === 0 ? "No issues found." : `${defrag.findings.length} finding${defrag.findings.length === 1 ? "" : "s"}: ${defrag.findings.slice(0, 4).map((finding) => finding.detail).join(" · ")}`}
          {defrag.planPath && <> · <span className="text-fg">{defrag.planPath}</span></>}
        </div>}
      </div>

      {selected && <div className="mt-4 rounded-2xl border border-line bg-elevated p-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] [overflow-wrap:anywhere]">{selected.text}</p>
            <p className="mt-1 text-[11.5px] text-muted">{selected.scope === "shared" ? "Shared" : bot.name}{selected.category ? ` · ${selected.category}` : ""}{selected.added ? ` · added ${selected.added}` : ""}</p>
          </div>
          <Pill variant="soft" onClick={() => setSelected(null)}>Close</Pill>
        </div>
        <div className="mt-3 border-t border-line pt-2 text-[12px] leading-relaxed text-muted">
          {selected.provenance?.quote
            ? <><span className="text-fg">“{selected.provenance.quote}”</span><br />{selected.provenance.author === "user" ? "You" : selected.provenance.author} · {selected.provenance.sourceMessageId ?? "no message id"} · {selected.provenance.at.slice(0, 10)}</>
            : selected.source ? `Source: ${selected.source}` : "No provenance recorded for this line."}
        </div>
        {selected.links.length > 0 && <p className="mt-1 text-[11.5px] text-muted">Links: {selected.links.join(", ")}</p>}
        <Pill variant="soft" disabled={forgetting} onClick={() => void forget()} className="mt-3 text-danger"><Trash2 size={13} /> {forgetting ? "Forgetting…" : "Forget"}</Pill>
      </div>}

      {note && <Modal title={note.path} onClose={() => setNote(null)} onBack={() => setNote(null)} className="w-[min(720px,94vw)]">
        <div className="dialog-body scroll-thin max-h-[70vh] overflow-y-auto px-4 py-4"><pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{note.text}</pre></div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          {(note.text.match(/^##\s+/gmu) ?? []).length >= 2 && <Pill variant="soft" onClick={() => void splitNote()}><Scissors size={13} /> Split at headings</Pill>}
          <Pill variant="soft" onClick={() => setNote(null)} className="ml-auto">Close</Pill>
        </div>
      </Modal>}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div className="rounded-xl border border-line bg-card px-3 py-2"><span className="block text-[18px]">{value}</span><span className="text-[11.5px] text-muted">{label}</span></div>;
}

function Section({ title, empty, children }: { title: string; empty: string | null; children: React.ReactNode }) {
  return <div className="mb-5">
    <div className="mb-1.5 px-1 text-[12.5px] text-muted">{title}</div>
    {empty ? <p className="rounded-xl border border-dashed border-line px-3 py-2.5 text-[12.5px] text-muted">{empty}</p> : <div className="overflow-hidden rounded-xl border border-line bg-card/50">{children}</div>}
  </div>;
}

function FactRow({ fact, onOpen }: { fact: ShownFact; onOpen: () => void }) {
  return <button onClick={onOpen} className={clsx("flex w-full items-start gap-2 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-hover", fact.scope === "shared" && "bg-card-inner/40")}>
    <Brain size={14} className="mt-0.5 shrink-0 text-muted" />
    <span className="min-w-0 flex-1">
      <span className="block text-[13.5px] leading-snug [overflow-wrap:anywhere]">{fact.text}</span>
      <span className="mt-0.5 block truncate text-[11.5px] text-muted">{fact.category ? `${fact.category} · ` : ""}{fact.added ? `added ${fact.added}` : fact.source ?? "no source"}{fact.scope === "shared" ? " · shared" : ""}</span>
    </span>
    <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted" />
  </button>;
}
