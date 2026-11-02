import { useEffect, useState } from "react";
import { watchProviderData } from "../lib/providerData";
import { parseProviderUsage, peakUsage, readUsageSummary, resetsIn, usageRange, type ProviderUsage, type UsageCost } from "../lib/usageApi";
import { Pill, Spinner } from "./ui";

/** The most-used limit across providers, for the Settings row. */
export function useUsagePeak() {
  const [peak, setPeak] = useState<number | null>(null);
  useEffect(() => watchProviderData((value) => { try { setPeak(peakUsage(parseProviderUsage(value))); } catch { setPeak(null); } }, () => setPeak(null)), []);
  return peak;
}

export function UsagePanel() {
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState("");
  const [cost, setCost] = useState<UsageCost[] | null>(null);
  const [costError, setCostError] = useState("");
  const [costHidden, setCostHidden] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [range] = useState(() => usageRange());
  useEffect(() => watchProviderData((value) => { try { setProviders(parseProviderUsage(value)); setError(""); } catch { setError("Couldn't read provider limits."); } }, () => setError("Couldn't load provider limits.")), [attempt]);
  useEffect(() => {
    let live = true; setCostError(""); setCost(null);
    readUsageSummary(range).then((value) => { if (live) setCost(value); }).catch((error: unknown) => {
      if (!live) return;
      // This gateway's T3 credential can't read costs, which is a setup detail rather than a failure.
      if (error instanceof Error && /diagnostics:read/.test(error.message)) setCostHidden(true);
      else setCostError("Cost summaries are unavailable on this connection.");
    });
    return () => { live = false; };
  }, [range, attempt]);
  return <div className="usage-panel">
    {error && <p role="alert">{error} <Pill variant="soft" onClick={() => setAttempt((n) => n + 1)}>Retry</Pill></p>}
    {!providers && !error && <Spinner />}
    {providers?.map((provider) => <section className="usage-provider" key={provider.id}><h3>{provider.name}</h3><div className="usage-card">{provider.windows.map((window) => <div className="usage-window" key={window.id}><div><span>{window.label} usage limit</span>{window.resetsAt && <small title={new Date(window.resetsAt).toLocaleString()}>{resetsIn(window.resetsAt)}</small>}</div><progress aria-label={`${provider.name} ${window.label} usage`} max={100} value={window.percent} /><span className="usage-percent">{Math.round(window.percent)}%</span></div>)}{!provider.windows.length && <p className="p-4 text-muted">{provider.unavailable ? "This provider doesn't report usage limits." : "No usage windows reported."}</p>}{provider.externalUrl && <a className="usage-manage" href={provider.externalUrl} target="_blank" rel="noreferrer">Manage usage ↗</a>}</div>{provider.checkedAt && <p className="usage-updated">Updated {new Date(provider.checkedAt).toLocaleString()}</p>}{provider.resetCredits !== null && <p className="usage-updated">{provider.resetCredits} reset credit{provider.resetCredits === 1 ? "" : "s"} available</p>}</section>)}
    {providers?.length === 0 && <p>No provider limits reported.</p>}
    {!costHidden && <section className="usage-provider"><h3>Estimated token cost</h3><p className="usage-updated">{range.sinceDay} – {range.untilDay} · {range.timeZone}</p>{costError ? <p role="status" className="usage-boundary">{costError}</p> : cost === null ? <Spinner /> : <div className="usage-card">{cost.map((row) => <div className="usage-window" key={row.provider}><div><span>{row.provider}</span><span>${row.cost.toFixed(2)}</span></div><small>{row.tokens.toLocaleString()} tokens{row.unpricedRecords ? ` · ${row.unpricedRecords} unpriced records` : ""}</small></div>)}{!cost.length && <p className="p-4 text-muted">No usage records in this period.</p>}</div>}<p className="usage-updated">Provider quotas and estimated token cost are separate measurements.</p></section>}
  </div>;
}
