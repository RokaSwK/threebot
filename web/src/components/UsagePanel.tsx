import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { watchProviderData } from "../lib/providerData";
import { parseProviderUsage, peakUsage, resetsIn, limitGroups, groupUsage, totalIn, formatTokens, readBotUsage, readUsageAccounts, type BotUsage, type UsageAccount, type UsageAccounts, type ProviderUsage, type UsageLimitCard, type UsageSeries } from "../lib/usageApi";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Pill, Spinner } from "./ui";
import { useApp } from "../store";
import { botColor } from "../lib/character";

/** The most-used limit across providers, for the Settings row. */
export function useUsagePeak() {
  const [peak, setPeak] = useState<number | null>(null);
  useEffect(() => watchProviderData((value) => { try { setPeak(peakUsage(parseProviderUsage(value))); } catch { setPeak(null); } }, () => setPeak(null)), []);
  return peak;
}

const dayFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));
const sourceNames = { you: "You", routine: "Routines", bot: "Other Bots" };
const seriesColor = (series: UsageSeries, index: number) => series.color ?? (series.key === "other" ? "var(--fg-faint)" : `var(--usage-s${(index % 4) + 1})`);
/** By Bot, each series wears its Bot's own colour; a colour already taken falls back to the palette so two Bots never look alike. */
function withBotColors(series: UsageSeries[], bots: Record<string, { color?: string }>): UsageSeries[] {
  const taken = new Set<string>();
  return series.map((s) => {
    const color = s.key === "other" ? undefined : bots[s.key] ? botColor(bots[s.key].color) : undefined;
    if (!color || taken.has(color)) return s;
    taken.add(color);
    return { ...s, color };
  });
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <div className="usage-seg" role="group" aria-label={label}>
    {options.map(([option, text]) => <button key={option} aria-pressed={value === option} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}

function LimitCard({ card }: { card: UsageLimitCard }) {
  return <section className="usage-card">
    <h3>{card.title}</h3>
    {card.rows.map((row, index) => {
      const percent = Math.round(row.percent);
      const warn = row.percent >= 80;
      return <div className="usage-prov" key={`${row.provider}:${index}`}>
        <div className="usage-tile" aria-hidden="true"><ProviderInstanceIcon driver={row.kind} displayName={row.provider} iconClassName="size-4" /></div>
        <div className="usage-who"><div className="usage-name" title={row.provider}>{row.provider}</div>{row.resetsAt && <div className="usage-reset">{resetsIn(row.resetsAt)}</div>}</div>
        <div className={`usage-bar${warn ? " usage-bar-warn" : ""}`} role="meter" aria-label={`${row.provider} ${card.title}`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, Math.max(1, percent))}%` }} /></div>
        <div className="usage-pct">{percent}%</div>
      </div>;
    })}
  </section>;
}

/** What the cards can't show: providers without limits, reset credits, where to manage usage, and how fresh the limits are. */
function LimitNotes({ providers }: { providers: ProviderUsage[] }) {
  const notes = providers.filter((p) => !p.windows.length || p.resetCredits !== null || p.externalUrl);
  const checked = providers.map((p) => p.checkedAt).filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort()[0];
  if (!notes.length && !checked) return null;
  return <div className="usage-notes">
    {notes.map((p) => <p key={p.id}>
      <span>{p.name}</span>
      {!p.windows.length && <span>{p.unavailable ? "doesn't report usage limits" : "no usage windows reported"}</span>}
      {p.resetCredits !== null && <span>{p.resetCredits} reset credit{p.resetCredits === 1 ? "" : "s"} available</span>}
      {p.externalUrl && <a href={p.externalUrl} target="_blank" rel="noreferrer">Manage usage ↗</a>}
    </p>)}
    {checked && <p>Updated {new Date(checked).toLocaleString()}</p>}
  </div>;
}

/** T3's totals for every transcript on the computer, per account, so Bot use can be read against all use. */
function AccountTotals({ accounts, botTokens }: { accounts: UsageAccounts; botTokens: number }) {
  const tokens = (a: UsageAccount) => a.input + a.cached + a.cacheWrite + a.output;
  const rows = [...accounts.accounts].sort((a, b) => tokens(b) - tokens(a));
  const all = rows.reduce((sum, a) => sum + tokens(a), 0);
  const unpriced = rows.reduce((sum, a) => sum + a.unpricedRecords, 0);
  return <section className="usage-card">
    {!rows.length ? <p className="usage-empty">No usage records in this period.</p> : <>
      {rows.map((a) => <div className="usage-acct" key={a.account}>
        <span className="usage-name">{a.account}</span>
        <span className="usage-vals">{formatTokens(tokens(a))} tokens</span>
        <span className="usage-vals">≈ ${a.costUsd.toFixed(2)}</span>
      </div>)}
      <p className="usage-accounts">Bots used {formatTokens(botTokens)} of {formatTokens(all)} tokens. Cost is T3's estimate{unpriced ? `; ${unpriced} record${unpriced === 1 ? " has" : "s have"} no price` : ""}. Limits and cost are measured separately.</p>
    </>}
  </section>;
}

function UsageChart({ series, days }: { series: UsageSeries[]; days: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => setWidth(box.current?.getBoundingClientRect().width || 700);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const W = width || 700, H = 200, L = 44, R = 12, B = 26, T = 8;
  const perDay = series.map((s) => days.map((_, i) => s.inp[i] + s.out[i]));
  const peak = Math.max(0, ...perDay.flat());
  const pow = 10 ** Math.floor(Math.log10(Math.max(peak, 1) / 4));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= Math.max(peak, 1) / 4) ?? 10 * pow;
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / days.length;
  const y = (v: number) => H - B - (v / max) * (H - B - T);
  // A day label is about 50px wide: label every day when they fit, else every few (Nov 11, Nov 16, …).
  const every = Math.max(1, Math.ceil((days.length * 54) / Math.max(1, W - L - R)));
  return <div className="usage-chart" ref={box} onMouseLeave={() => setHover(null)}>
    <svg role="img" aria-label="Tokens per day" viewBox={`0 0 ${W} ${H}`}>
      {Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step).map((v) => <g key={v}>
        <line className="usage-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
        <text x={L - 10} y={y(v) + 4} textAnchor="end">{formatTokens(v)}</text>
      </g>)}
      {days.map((day, i) => (i % every === 0 ? <text key={day} x={x(i)} y={H - 6} textAnchor="middle">{fmtDay(day)}</text> : null))}
      {series.map((s, k) => <g key={s.key} fill="none" stroke={seriesColor(s, k)}>
        <polyline strokeWidth={1.5} strokeLinejoin="round" points={perDay[k].map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        {perDay[k].map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={4} fill="var(--bg-card-inner)" strokeWidth={2} />)}
      </g>)}
      {days.map((day, i) => <rect key={day} data-day={day} x={L + ((W - L - R) * i) / days.length} y={0} width={(W - L - R) / days.length} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} />)}
    </svg>
    {/* Centred on its day; in the first and last third it sits against that side of the chart so a phone doesn't clip it. */}
    {hover !== null && <div className="usage-tip" style={hover < days.length / 3 ? { left: 0, top: 4, transform: "none" } : hover >= (days.length * 2) / 3 ? { right: 0, top: 4, transform: "none" } : { left: `${((hover + 0.5) / days.length) * 100}%`, top: 4 }}>
      <b>{fmtDay(days[hover])}</b>
      {series.map((s, k) => <div className="usage-tiprow" key={s.key}>
        <span><i className="usage-sq" style={{ background: seriesColor(s, k) }} />{s.name}</span>
        <span>{formatTokens(s.inp[hover])} in · {formatTokens(s.out[hover])} out</span>
      </div>)}
    </div>}
  </div>;
}

export function UsagePanel() {
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [range, setRange] = useState<"7" | "30">("7");
  const [by, setBy] = useState<"bot" | "source" | "model">("bot");
  const [usage, setUsage] = useState<BotUsage | null>(null);
  const [usageError, setUsageError] = useState("");
  const [accounts, setAccounts] = useState<UsageAccounts | null>(null);
  const [accountsError, setAccountsError] = useState(false);
  const bots = useApp((s) => s.bots);
  const cards = useMemo(() => providers ? limitGroups(providers) : [], [providers]);
  const names = useMemo(() => {
    if (by === "source") return sourceNames;
    if (by === "bot") return Object.fromEntries(Object.values(bots).map((bot) => [bot.slug, bot.name]));
    return {};
  }, [by, bots]);
  const series = useMemo(() => { const grouped = usage ? groupUsage(usage.rows, by, names, usage.days) : []; return by === "bot" ? withBotColors(grouped, bots) : grouped; }, [usage, by, names, bots]);
  const days = usage?.days ?? [];
  const allIn = series.reduce((sum, s) => sum + s.totalIn, 0), allOut = series.reduce((sum, s) => sum + s.totalOut, 0);
  const allTokens = usage?.rows.reduce((sum, row) => sum + totalIn(row) + row.output, 0) ?? 0;
  const allCached = usage?.rows.reduce((sum, row) => sum + row.cached, 0) ?? 0;
  useEffect(() => watchProviderData((value) => { try { setProviders(parseProviderUsage(value)); setError(""); } catch { setError("Couldn't read provider limits."); } }, () => setError("Couldn't load provider limits.")), [attempt]);
  useEffect(() => {
    let live = true; setUsageError(""); setUsage(null); setAccounts(null); setAccountsError(false);
    const days = range === "7" ? 7 : 30;
    readBotUsage(days).then((value) => { if (live) setUsage(value); }).catch(() => { if (live) setUsageError("Couldn't load Bot usage."); });
    readUsageAccounts(days).then((value) => { if (live) setAccounts(value); }).catch(() => { if (live) setAccountsError(true); });
    return () => { live = false; };
  }, [range, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  return <div className="usage-panel usage-page">
    <p className="usage-label">Limits</p>
    {error && <p role="alert">{error} <Pill variant="soft" onClick={retry}>Retry</Pill></p>}
    {!providers && !error && <Spinner />}
    <div className="usage-cards">{cards.map((card) => <LimitCard key={card.title} card={card} />)}</div>
    {providers?.length === 0 && <p>No provider limits reported.</p>}
    {providers && <LimitNotes providers={providers} />}

    <p className="usage-label">Bot usage</p>
    <section className="usage-card">
      {usageError ? <p role="alert">{usageError} <Pill variant="soft" onClick={retry}>Retry</Pill></p>
        : !usage ? <Spinner />
        : !usage.rows.length ? <p className="usage-empty">No Bot turns in this period yet.</p>
        : <>
          <div className="usage-top">
            <div>
              <div className="usage-big">{formatTokens(allIn + allOut)} tokens</div>
              <div className="usage-sub">{formatTokens(allIn)} in · {formatTokens(allOut)} out · {allTokens ? Math.round((allCached / allTokens) * 100) : 0}% from cache · {fmtDay(usage.since)} – {fmtDay(usage.until)}</div>
              {usage.ledgerSince.slice(0, 10) > usage.since && <div className="usage-sub">Counting since {fmtDay(usage.ledgerSince.slice(0, 10))}</div>}
            </div>
            <div className="usage-segs">
              <Segmented label="Group by" value={by} options={[["source", "By source"], ["bot", "By Bot"], ["model", "By model"]]} onChange={(value) => setBy(value as typeof by)} />
              <Segmented label="Period" value={range} options={[["7", "7 days"], ["30", "30 days"]]} onChange={(value) => setRange(value as "7" | "30")} />
            </div>
          </div>
          <div className="usage-stack">{series.map((s, i) => <i key={s.key} style={{ flex: s.totalIn + s.totalOut, background: seriesColor(s, i) }} />)}</div>
          <div className="usage-legend">
            {series.map((s, i) => <div key={s.key}>
              <span className="usage-sq" style={{ background: seriesColor(s, i) }} />
              <span className="usage-name">{s.name}</span>
              <span className="usage-vals">{formatTokens(s.totalIn)} in · {formatTokens(s.totalOut)} out</span>
            </div>)}
          </div>
          <UsageChart series={series} days={days} />
        </>}
    </section>

    <p className="usage-label">All use on this computer</p>
    {accountsError ? <p role="status" className="usage-empty">Totals for all use aren't available on this connection.</p>
      : !accounts ? <Spinner /> : <AccountTotals accounts={accounts} botTokens={allIn + allOut} />}
  </div>;
}
