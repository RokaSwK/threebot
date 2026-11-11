import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, FolderGit2, Folder, MessageSquare, Plus } from "lucide-react";
import clsx from "clsx";
import { Avatar } from "./Avatar";
import { AvatarEditorDialog, AvatarPicker, type AvatarDraft } from "./AvatarEditor";
import { Modal, Pill, Spinner } from "./ui";
import { adoptProject, openDialog, toast, updateBot, useApp } from "../store";
import { api } from "../lib/api";
import { DEFAULT_AVATAR } from "../lib/character";
import type { AdoptableProject } from "../lib/types";
import { mainThreadChoices } from "../lib/adopt";


/** "Make a Bot from a project": pick one of this machine's T3 projects, then name the Bot and pick its main thread. */
export function AdoptProjectDialog() {
  const [projects, setProjects] = useState<AdoptableProject[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<AdoptableProject | null>(null);
  const close = () => openDialog(null);
  useEffect(() => {
    let live = true;
    setError("");
    api.adoptableProjects().then((list) => { if (live) setProjects(list.filter((project) => project.exists)); }, (e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't list your projects."); });
    return () => { live = false; };
  }, [attempt]);
  if (picked) return <AdoptProjectForm project={picked} onBack={() => setPicked(null)} />;
  return (
    <Modal onClose={close} onBack={() => openDialog("new-bot")} title="From an existing project" className="adopt-sheet w-[480px]">
      <div className="dialog-body px-4 pt-3 pb-4">
        <p className="mb-3 text-[13px] text-muted">The Bot works in the project's own folder and keeps its files out of git.</p>
        {error ? <div role="alert" className="grid gap-3 py-6 text-center text-[13px] text-muted">{error}<div><Pill variant="soft" onClick={() => setAttempt((n) => n + 1)}>Try again</Pill></div></div>
          : !projects ? <div role="status" className="grid h-32 place-items-center"><Spinner /></div>
          : projects.length === 0 ? <p className="py-8 text-center text-[13.5px] text-muted">Every T3 project on this machine is a Bot already.</p>
          : <ul aria-label="Projects" className="adopt-projects overflow-hidden rounded-2xl border border-line bg-card/50">
            {projects.map((project) => (
              <li key={project.id} className="border-b border-line last:border-0">
                <button onClick={() => setPicked(project)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-active text-muted">{project.git ? <FolderGit2 size={16} /> : <Folder size={16} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{project.title}{project.archived && <span className="ml-2 text-[12px] text-muted">Archived</span>}</span>
                    <span className="block truncate font-mono text-[12px] text-muted" title={project.workspaceRoot}>{project.workspaceRoot}</span>
                  </span>
                  <ChevronRight size={18} className="shrink-0 text-muted" />
                </button>
              </li>
            ))}
          </ul>}
      </div>
    </Modal>
  );
}

function AdoptProjectForm({ project, onBack }: { project: AdoptableProject; onBack: () => void }) {
  const bots = useApp((s) => s.bots);
  const allThreads = useApp((s) => s.threads);
  const first = Object.keys(bots).length === 0;
  const threads = useMemo(() => mainThreadChoices(Object.values(allThreads), project.id), [allThreads, project.id]);
  const [name, setName] = useState(project.title);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarDraft>({ ...DEFAULT_AVATAR });
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const bot = await adoptProject({ projectId: project.id, threadId, name: name.trim(), ...avatar, primary: first });
      if (first) await updateBot(bot.slug, { pinned: true });
      openDialog(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't make the Bot");
      setBusy(false);
    }
  };
  const option = (id: string | null, title: string, detail: string, icon: ReactNode) => (
    <li key={id ?? "new"} className="border-b border-line last:border-0">
      <label className={clsx("flex cursor-pointer items-center gap-3 px-4 py-3", threadId === id ? "bg-active" : "hover:bg-hover")}>
        <input type="radio" name="main-thread" className="sr-only" checked={threadId === id} onChange={() => setThreadId(id)} />
        <span className="grid size-7 shrink-0 place-items-center text-muted">{icon}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[14px]">{title}</span><span className="block truncate text-[12px] text-muted">{detail}</span></span>
        <span aria-hidden className={clsx("size-4 shrink-0 rounded-full border", threadId === id ? "border-[5px] border-fg" : "border-line-strong")} />
      </label>
    </li>
  );
  return (
    <Modal onClose={() => openDialog(null)} onBack={onBack} title="Make a Bot" className="adopt-sheet w-[480px]">
      <div className="dialog-body px-4 pt-2 pb-4">
        <div className="flex flex-col items-center pt-2">
          <button type="button" aria-label="Edit Bot avatar" onClick={() => setPicker(true)}><Avatar {...avatar} picture={avatar.avatarImage} definition={avatar.avatarDefinition} size={120} state="idle" /></button>
          <input aria-label="Name your Bot" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Name your Bot"
            className="mt-3 h-10 w-full rounded-xl border border-line bg-transparent text-center text-[14px] outline-none placeholder:text-faint focus:border-line-strong" />
          <p className="mt-2 max-w-full truncate font-mono text-[12px] text-muted" title={project.workspaceRoot}>{project.workspaceRoot}</p>
        </div>
        <div className="mt-4 mb-2 text-[12.5px] text-muted">Main conversation</div>
        <ul aria-label="Main conversation" className="adopt-threads overflow-hidden rounded-2xl border border-line bg-card/50">
          {option(null, "Start a new conversation", "A fresh thread in this project", <Plus size={16} />)}
          {threads.slice(0, 30).map((thread) => option(thread.id, thread.title || "Untitled thread", "Keep this thread and its history", <MessageSquare size={16} />))}
        </ul>
        <p className="mt-3 text-[12.5px] text-muted">The project's own threads, files and git history stay as they are. You can turn it back into a plain project any time.</p>
        <div className="mt-4 text-[12.5px] text-muted">Look</div>
        <AvatarPicker shape={avatar.shape} color={avatar.color} disabled={busy} onChange={(shape, color) => setAvatar({ shape, color, avatarImage: null, avatarDefinition: shape === avatar.shape ? avatar.avatarDefinition : null })} />
      </div>
      <div className="dialog-footer flex items-center gap-2 border-t border-line px-3 py-3">
        <Pill onClick={create} disabled={!name.trim() || busy}>{busy && <Spinner />} Make Bot</Pill>
      </div>
      {picker && <AvatarEditorDialog initial={avatar} onSave={async (draft) => { setAvatar(draft); }} onClose={() => setPicker(false)} />}
    </Modal>
  );
}
