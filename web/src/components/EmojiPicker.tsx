import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Search } from "lucide-react";

type EmojiGroup = { name: string; emojis: { emoji: string; name: string; slug: string }[] };

// The catalog is large and rarely opened, so it stays out of the main bundle.
let catalog: Promise<EmojiGroup[]> | null = null;
function loadCatalog() {
  catalog ??= import("unicode-emoji-json/data-by-group.json").then((module) => module.default as EmojiGroup[]);
  return catalog;
}

export function EmojiPicker({ onBack, onPick }: { onBack: () => void; onPick: (emoji: string) => void }) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let current = true;
    loadCatalog().then((value) => { if (current) setGroups(value); }, () => { catalog = null; if (current) setGroups([]); });
    return () => { current = false; };
  }, []);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!groups || !term) return groups ?? [];
    return groups.map((group) => ({ ...group, emojis: group.emojis.filter((item) => item.name.includes(term) || item.slug.includes(term)) })).filter((group) => group.emojis.length);
  }, [groups, query]);
  return <div className="emoji-picker">
    <div className="emoji-picker-search">
      <button type="button" aria-label="Back to actions" onClick={onBack}><ChevronLeft size={26} aria-hidden="true" /></button>
      <label><Search size={18} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search emoji" aria-label="Search emoji" /></label>
    </div>
    <div className="emoji-picker-scroll">
      {groups?.length === 0 && <p role="alert">Couldn't load emoji. Go back and try again.</p>}
      {groups && groups.length > 0 && visible.length === 0 && <p>No emoji found</p>}
      {visible.map((group) => <section key={group.name} aria-label={group.name}>
        <h3>{group.name.replace(" & Emotion", " & People")}</h3>
        <div>{group.emojis.map((item) => <button key={item.slug} type="button" aria-label={`React with ${item.name}`} onClick={() => onPick(item.emoji)}>{item.emoji}</button>)}</div>
      </section>)}
    </div>
  </div>;
}
