// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5):
// apps/web/src/components/chat/modelPickerKeys.ts, modelPickerSearch.ts, apps/web/src/modelOrdering.ts,
// apps/web/src/modelSelection.ts and packages/shared/src/searchRanking.ts.
// Model picker list keys, ordering (hidden models, model order, favorites) and search ranking.
import type { ProviderModel } from "./types";

// ---------- keys ----------

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";

export function modelPickerModelKey(instanceId: string, slug: string): string {
  return `${MODEL_KEY_PREFIX}${instanceId.length}:${instanceId}${slug}`;
}

export function parseModelPickerModelKey(key: string): { instanceId: string; slug: string } | null {
  if (!key.startsWith(MODEL_KEY_PREFIX)) return null;
  const encoded = key.slice(MODEL_KEY_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex === -1) return null;
  const lengthText = encoded.slice(0, separatorIndex);
  if (!/^\d+$/.test(lengthText)) return null;
  const length = Number(lengthText);
  const value = encoded.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(length) || length > value.length) return null;
  return { instanceId: value.slice(0, length), slug: value.slice(length) };
}

export function modelPickerLegacySectionKey(instanceId: string): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): string | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX) ? key.slice(LEGACY_SECTION_KEY_PREFIX.length) : null;
}

export function providerModelKey(instanceId: string, slug: string): string {
  return `${instanceId}:${slug}`;
}

// ---------- ordering ----------

function rank<T>(values: ReadonlyArray<T>): Map<T, number> {
  return new Map(values.map((value, index) => [value, index] as const));
}

/** Drops the models hidden in T3's settings and applies its custom order, like T3's picker. */
export function applyModelPreferences(models: ReadonlyArray<ProviderModel>, preferences: { hiddenModels: string[]; modelOrder: string[] } | undefined): ProviderModel[] {
  const hidden = new Set(preferences?.hiddenModels ?? []);
  const order = rank(preferences?.modelOrder ?? []);
  const original = rank(models.map((model) => model.slug));
  return models
    .filter((model) => model.isCustom || !hidden.has(model.slug))
    .toSorted(
      (a, b) =>
        (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity) || (original.get(a.slug) ?? Infinity) - (original.get(b.slug) ?? Infinity),
    );
}

export function sortProviderModelItems<T extends { instanceId: string; slug: string }>(
  items: ReadonlyArray<T>,
  options: { favoriteModelKeys: ReadonlySet<string>; groupFavorites: boolean; instanceOrder: ReadonlyArray<string> },
): T[] {
  const instanceOrder = rank(options.instanceOrder);
  const original = rank(items.map((item) => providerModelKey(item.instanceId, item.slug)));
  const favorite = (item: T) => (options.favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)) ? 0 : 1);
  return items.toSorted(
    (a, b) =>
      (options.groupFavorites ? favorite(a) - favorite(b) : 0) ||
      (instanceOrder.get(a.instanceId) ?? Infinity) - (instanceOrder.get(b.instanceId) ?? Infinity) ||
      (original.get(providerModelKey(a.instanceId, a.slug)) ?? Infinity) - (original.get(providerModelKey(b.instanceId, b.slug)) ?? Infinity),
  );
}

// ---------- search ----------

function normalizeSearchQuery(input: string): string {
  return input.trim().toLowerCase();
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) return gapPenalty * 3 + (valueIndex - firstMatchIndex + 1 - query.length);
  }
  return null;
}

/** T3's scoreQueryMatch with `ignorePosition`; lower is better. */
function scoreQueryMatch(value: string, query: string, base: number): number | null {
  if (!value || !query) return null;
  if (value === query) return base;
  if (value.startsWith(query)) return base + 2;
  if ([" ", "-", "_", "/"].some((marker) => value.includes(`${marker}${query}`))) return base + 4;
  if (value.includes(query)) return base + 6;
  if (query.length >= 3) {
    const fuzzy = scoreSubsequenceMatch(value, query);
    if (fuzzy !== null) return base + 100 + fuzzy;
  }
  return null;
}

export type ModelPickerSearchableModel = {
  driver: string;
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const FAVORITE_SCORE_BOOST = 24;
const EXACT_NAME_SCORE = -1000;

function searchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery([model.name, model.shortName, model.subProvider, model.driver, model.providerDisplayName].filter(Boolean).join(" "));
}

export function scoreModelPickerSearch(model: ModelPickerSearchableModel, query: string): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return 0;
  const normalizedQuery = tokens.join(" ");
  const normalizeName = (name: string) => normalizeSearchQuery(name).replace(/\s+/gu, " ");
  if (normalizedQuery === normalizeName(model.name) || normalizedQuery === normalizeName(model.shortName ?? "")) return EXACT_NAME_SCORE;

  const fields = [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driver),
    normalizeSearchQuery(model.providerDisplayName),
    searchText(model),
  ];
  let score = 0;
  for (const token of tokens) {
    const tokenScores = fields.flatMap((field, index) => {
      const fieldScore = scoreQueryMatch(field, token, index * 10);
      return fieldScore === null ? [] : [fieldScore];
    });
    if (tokenScores.length === 0) return null;
    score += Math.min(...tokenScores);
  }
  return model.isFavorite ? score - FAVORITE_SCORE_BOOST : score;
}

export function rankModelPickerSearch<T>(items: ReadonlyArray<T>, query: string, toSearchable: (item: T) => ModelPickerSearchableModel): T[] {
  const ranked: { item: T; score: number; isFavorite: boolean; order: number }[] = [];
  items.forEach((item, order) => {
    const searchable = toSearchable(item);
    const score = scoreModelPickerSearch(searchable, query);
    if (score !== null) ranked.push({ item, score, isFavorite: searchable.isFavorite === true, order });
  });
  return ranked.toSorted((a, b) => a.score - b.score || Number(b.isFavorite) - Number(a.isFavorite) || a.order - b.order).map((entry) => entry.item);
}
