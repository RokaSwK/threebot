import { isRecord, providerRecords } from "./providerData";
import { t3 } from "./t3";

export type UsageWindow = { id: string; label: string; percent: number; resetsAt: string | null };
export type ProviderUsage = { id: string; name: string; windows: UsageWindow[]; checkedAt: string | null; unavailable: boolean; resetCredits: number | null; externalUrl: string | null };
export function parseProviderUsage(value: unknown): ProviderUsage[] {
  return providerRecords(value).flatMap((provider) => {
    // A disabled provider can still carry a stale limits record.
    if (provider.enabled === false || typeof provider.instanceId !== "string" || typeof provider.displayName !== "string" || !isRecord(provider.usageLimits)) return [];
    const limits = provider.usageLimits;
    const windows = (Array.isArray(limits.windows) ? limits.windows : []).flatMap((window): UsageWindow[] => {
      if (!isRecord(window) || typeof window.id !== "string" || typeof window.label !== "string" || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
      return [{ id: window.id, label: window.label, percent: window.usedPercent, resetsAt: typeof window.resetsAt === "string" && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : null }];
    });
    const external = isRecord(limits.externalUsage) && typeof limits.externalUsage.url === "string" && /^https:\/\//.test(limits.externalUsage.url) ? limits.externalUsage.url : null;
    return [{ id: provider.instanceId, name: provider.displayName, windows, checkedAt: typeof limits.checkedAt === "string" ? limits.checkedAt : null, unavailable: !!limits.unavailable, resetCredits: isRecord(limits.resetCredits) && typeof limits.resetCredits.availableCount === "number" ? limits.resetCredits.availableCount : null, externalUrl: external }];
  });
}

/** The native reset wording: the time left, in its largest whole unit. */
export function resetsIn(iso: string, now = Date.now()) {
  const minutes = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return "Resets soon";
  const [count, unit] = minutes >= 2880 ? [Math.round(minutes / 1440), "day"] : minutes >= 90 ? [Math.round(minutes / 60), "hour"] : [minutes, "minute"];
  return `Resets in ${count} ${unit}${count === 1 ? "" : "s"}`;
}

export const peakUsage = (providers: ProviderUsage[]) => {
  const percents = providers.flatMap((provider) => provider.windows.map((window) => window.percent));
  return percents.length ? Math.round(Math.max(...percents)) : null;
};

export type UsageCost = { provider: string; cost: number; tokens: number; unpricedRecords: number };
export function parseUsageSummary(value: unknown): UsageCost[] {
  if (!isRecord(value) || typeof value.contractVersion !== "number" || !Array.isArray(value.buckets)) throw new Error("This server's usage summary format is unsupported.");
  const totals = new Map<string, UsageCost>();
  for (const bucket of value.buckets) {
    if (!isRecord(bucket) || typeof bucket.provider !== "string" || typeof bucket.costUsd !== "number" || !Number.isFinite(bucket.costUsd) || !isRecord(bucket.totals)) continue;
    const tokens = [bucket.totals.uncachedInputTokens, bucket.totals.cachedInputTokens, bucket.totals.cacheCreationTokens, bucket.totals.outputTokens];
    if (!tokens.every((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)) continue;
    const current = totals.get(bucket.provider) ?? { provider: bucket.provider, cost: 0, tokens: 0, unpricedRecords: 0 };
    current.cost += bucket.costUsd; current.tokens += tokens.reduce((sum, n) => sum + n, 0); current.unpricedRecords += typeof bucket.unpricedRecords === "number" ? bucket.unpricedRecords : 0;
    totals.set(bucket.provider, current);
  }
  return [...totals.values()];
}
export function usageRange(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return { sinceDay: day(new Date(now.getTime() - 6 * 86400000)), untilDay: day(now), timeZone };
}
export const readUsageSummary = (range: ReturnType<typeof usageRange>) => t3.call<unknown>("server.getUsageSummary", range).then(parseUsageSummary);
