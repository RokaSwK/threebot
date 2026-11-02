import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { copyText } from "../lib/t3";
import { watchProviderData } from "../lib/providerData";
import { parseSkills, refreshWorkspaceSkills, type ProviderSkill } from "../lib/skillsApi";
import { toast, useApp } from "../store";
import { Modal, Pill, Spinner } from "./ui";

export function SkillsDialog({ onClose, initialQuery = "" }: { onClose: () => void; initialQuery?: string }) {
  const bot = useApp((s) => s.selected ? s.bots[s.selected] : null);
  const [skills, setSkills] = useState<ProviderSkill[] | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const refreshRevision = useRef(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setRefreshing(false); const stop = watchProviderData((value) => { try { setSkills(parseSkills(value, bot?.workspaceRoot ?? null)); setError(""); } catch { setError("Couldn't read skills."); } }, () => setError("Couldn't load provider skills."), bot?.mainThreadId ?? null); return () => { refreshRevision.current++; stop(); }; }, [bot?.workspaceRoot, bot?.mainThreadId, attempt]);
  const refresh = async () => {
    const model = bot?.model;
    if (!bot || !model || refreshing) return;
    const revision = refreshRevision.current;
    setRefreshing(true);
    try { const result = await refreshWorkspaceSkills(model.instanceId, bot.workspaceRoot, bot.mainThreadId); if (revision === refreshRevision.current) { setSkills(parseSkills(result, bot.workspaceRoot)); setError(""); } }
    catch { if (revision === refreshRevision.current) setError("Couldn't refresh this workspace. Provider discovery needs providers:manage access."); }
    finally { if (revision === refreshRevision.current) setRefreshing(false); }
  };
  const shown = skills?.filter((skill) => [skill.title, skill.description, skill.provider].some((text) => text.toLowerCase().includes(query.toLowerCase())));
  return <Modal title="Skills" onClose={onClose} className="skills-sheet h-[680px] w-[600px]"><div className="dialog-body p-4"><p className="mb-4 text-[13px] text-muted">Skills available from your providers. Workspace skills appear when T3 has a snapshot for this Bot.</p>{bot?.model && <Pill variant="soft" disabled={refreshing} onClick={() => void refresh()} className="mb-4">{refreshing ? <Spinner /> : null}Refresh workspace skills</Pill>}<label className="skills-search"><Search size={17} /><input aria-label="Search skills" placeholder="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{error && <p role="alert">{error} <Pill variant="soft" onClick={() => setAttempt((n) => n + 1)}>Retry</Pill></p>}{!skills && !error && <Spinner />}{shown?.map((skill) => <div className="skill-row" key={skill.key}><div><strong>{skill.title}</strong><small>{skill.provider} · {skill.scope}{skill.cwd ? " · This Bot" : " · Global"}</small><p>{skill.description}</p></div><Pill variant="soft" disabled={!skill.enabled || !skill.invocable} onClick={() => void copyText(`/${skill.name}`).then(() => toast("Skill command copied")).catch(() => toast("Couldn't copy skill command"))}>{!skill.enabled ? "Disabled" : !skill.invocable ? "Agent only" : "Copy command"}</Pill></div>)}{shown?.length === 0 && <p className="py-6 text-muted">No skills{query ? " match your search" : " reported for this workspace"}.</p>}</div></Modal>;
}
