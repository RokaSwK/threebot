import { useState, type ReactNode } from "react";
import { appDomain, siteIconUrl } from "../lib/siteIcons";

type Source = string | null | undefined;

/** The logos to try for an app, best first: its own icons, then its site's icon. */
export function appIconSources(name: string, icons: Source | Source[], domain?: string | null) {
  const known = appDomain(name);
  const candidates = [...(Array.isArray(icons) ? icons : [icons]), known && siteIconUrl(known), domain && siteIconUrl(domain)];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

/** An app's logo. Each source that fails to load gives way to the next, then to the fallback. */
export function AppIcon({ name, src, domain, fallback, badge }: { name: string; src?: Source | Source[]; domain?: string | null; fallback?: ReactNode; badge?: ReactNode }) {
  const sources = appIconSources(name, src, domain);
  const [failed, setFailed] = useState<string[]>([]);
  const logo = sources.find((source) => !failed.includes(source));
  const tile = <span data-app-name={name} className={`grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl text-[13px] font-medium ${logo ? "bg-white" : "bg-card"}`}>{logo ? <img src={logo} alt="" loading="lazy" className="size-6 object-contain" onError={() => setFailed((list) => [...list, logo])} /> : fallback ?? name.slice(0, 1).toUpperCase()}</span>;
  if (!badge) return tile;
  return <span className="relative shrink-0">{tile}<span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-success text-white ring-2 ring-elevated">{badge}</span></span>;
}
