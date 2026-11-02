// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5):
// packages/shared/src/model.ts, packages/client-runtime/src/modelTraits.ts,
// packages/provider-core/src/modelShortName.ts and apps/web/src/components/chat/providerIconUtils.ts.
// Model option descriptors, their current values and labels, and model display names.
import type { ModelSelection, ProviderModel, ProviderOptionDescriptor, ProviderOptionSelection } from "./types";

export type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
export type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

export const REASONING_SELECT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort", "reasoning", "variant", "thinking"]);

function rawSelectionValue(selections: ReadonlyArray<ProviderOptionSelection> | null | undefined, id: string) {
  return selections?.find((selection) => selection.id === id)?.value;
}

// T3 maps prompt-injected values (Ultrathink) back to the default here because it sends them as a
// prompt prefix. This app sends every value, Ultrathink included, as a plain option.
function resolveDescriptorChoiceValue(descriptor: SelectDescriptor, raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  const fallback = descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  if (!trimmed) return fallback;
  if (descriptor.options.length === 0) return trimmed;
  return descriptor.options.some((option) => option.id === trimmed) ? trimmed : fallback;
}

function withDescriptorCurrentValue(descriptor: ProviderOptionDescriptor, raw: string | boolean | undefined): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") return typeof raw === "boolean" ? { ...descriptor, currentValue: raw } : descriptor;
  const currentValue = resolveDescriptorChoiceValue(descriptor, typeof raw === "string" ? raw : descriptor.currentValue);
  if (!currentValue) {
    const { currentValue: _unused, ...rest } = descriptor;
    return rest;
  }
  return { ...descriptor, currentValue };
}

/** The model's option descriptors, each carrying the value the selection resolves to. */
export function getProviderOptionDescriptors(
  model: ProviderModel | null | undefined,
  selections?: ReadonlyArray<ProviderOptionSelection> | null,
): ProviderOptionDescriptor[] {
  return (model?.capabilities?.optionDescriptors ?? []).map((descriptor) =>
    withDescriptorCurrentValue(descriptor, rawSelectionValue(selections, descriptor.id) ?? descriptor.currentValue),
  );
}

export function getProviderOptionCurrentValue(descriptor: ProviderOptionDescriptor | null | undefined): string | boolean | undefined {
  if (!descriptor) return undefined;
  if (descriptor.type === "boolean") return descriptor.currentValue;
  return descriptor.currentValue || descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(descriptor: ProviderOptionDescriptor | null | undefined): string | undefined {
  if (!descriptor) return undefined;
  if (descriptor.type === "boolean") return typeof descriptor.currentValue === "boolean" ? (descriptor.currentValue ? "On" : "Off") : undefined;
  const currentValue = getProviderOptionCurrentValue(descriptor);
  return descriptor.options.find((option) => option.id === currentValue)?.label;
}

export function getDescriptorStringValue(descriptor: SelectDescriptor | null): string | null {
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : null;
}

export function buildProviderOptionSelectionsFromDescriptors(descriptors: ReadonlyArray<ProviderOptionDescriptor>): ProviderOptionSelection[] {
  const selections: ProviderOptionSelection[] = [];
  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") selections.push({ id: descriptor.id, value });
  }
  return selections;
}

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean,
): ProviderOptionDescriptor[] {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? { ...descriptor, ...(typeof currentValue === "boolean" ? { currentValue } : {}) }
        : { ...descriptor, ...(typeof currentValue === "string" ? { currentValue } : {}) },
  );
}

/** What the traits picker shows and edits for one model selection. */
export function getSelectedTraits(model: ProviderModel | null | undefined, selections: ReadonlyArray<ProviderOptionSelection> | null | undefined) {
  const descriptors = getProviderOptionDescriptors(model, selections);
  const selectDescriptors = descriptors.filter((d): d is SelectDescriptor => d.type === "select");
  const booleanDescriptors = descriptors.filter((d): d is BooleanDescriptor => d.type === "boolean");
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const hasAnyControls =
    primarySelectDescriptor !== null ||
    booleanDescriptors.some((d) => d.id === "fastMode" || d.id === "thinking") ||
    selectDescriptors.some((d) => d.id === "contextWindow" || d.id === "agent");
  return { descriptors, selectDescriptors, booleanDescriptors, primarySelectDescriptor, hasAnyControls };
}

export function buildTraitsTriggerDisplay(input: {
  driver: string;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): { label: string; speedLabel: string | null; otherLabels: ReadonlyArray<string> } {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: string[] = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    if (input.driver === "codex" && descriptor.id === "serviceTier" && descriptor.type === "select") {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
      if (
        ((fastTier || ultrafastTier) && currentValue === "default") ||
        (fastTier && currentValue === fastTier.id) ||
        (ultrafastTier && currentValue === ultrafastTier.id)
      ) {
        speedLabel = ultrafastTier && currentValue === ultrafastTier.id ? "Ultrafast" : fastTier && currentValue === fastTier.id ? "Fast" : null;
        fastModeFallbackLabel = descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal";
        continue;
      }
    }
    const label =
      descriptor.type === "boolean" ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}` : getProviderOptionCurrentLabel(descriptor);
    if (typeof label === "string" && label.length > 0) {
      if (reasoningLabelIndex === -1 && descriptor.type === "select" && REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id)) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  const otherLabels = labels.filter((_, index) => index !== reasoningLabelIndex);
  if (labels.length === 0 && fastModeFallbackLabel !== null) return { label: fastModeFallbackLabel, speedLabel, otherLabels };
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    else labels.push(speedLabel);
  }
  return { label: labels.join(" · "), speedLabel, otherLabels };
}

/**
 * The selection for a newly picked model. Like T3's sticky provider options, every option the new
 * model also offers (with a valid value) carries over; the rest fall back to the model's defaults.
 */
export function selectionForModel(instanceId: string, model: ProviderModel | undefined, slug: string, previous?: ReadonlyArray<ProviderOptionSelection>): ModelSelection {
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const options = (previous ?? []).filter((option) => {
    const descriptor = descriptors.find((d) => d.id === option.id);
    if (!descriptor) return false;
    if (descriptor.type === "boolean") return typeof option.value === "boolean";
    return typeof option.value === "string" && (descriptor.options.length === 0 || descriptor.options.some((choice) => choice.id === option.value));
  });
  return { instanceId, model: slug, options };
}

// ---------- model names ----------

const MODEL_FAMILIES_BY_DRIVER: Readonly<Record<string, ReadonlyArray<string>>> = {
  codex: ["GPT-", "GPT "],
  claudeAgent: ["Claude "],
  antigravity: ["Gemini "],
};

const FAMILY_PREFIXES = ["Claude ", "GPT-", "GPT ", "Gemini ", "Muse ", "Grok "] as const;

// Words that describe a variant within a family rather than name a model.
const VARIANT_WORDS = new Set([
  "pro", "flash", "mini", "max", "lite", "nano", "ultra", "plus", "fast", "turbo", "preview", "latest", "thinking", "reasoning", "build", "code",
  "image", "vision", "audio", "live", "custom", "tools", "exp", "experimental", "chat", "tts", "stt", "non", "transcribe",
]);
const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;
const VENDOR_PREFIX = /^[A-Z][\w.&\- ]{0,24}: (?=\S)/;

function nonVersionWords(text: string): ReadonlyArray<string> {
  return text
    .replace(/\(.*?\)/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 0 && !VERSION.test(word));
}

function namesModel(text: string): boolean {
  return nonVersionWords(text).some((word) => !VARIANT_WORDS.has(word.toLowerCase()));
}

function withoutFamily(name: string, nativeFamilies: ReadonlyArray<string>): string | undefined {
  const prefix = FAMILY_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return undefined;
  const rest = name.slice(prefix.length).trim();
  const keep = nativeFamilies.includes(prefix) ? nonVersionWords(rest).length > 0 : namesModel(rest);
  if (!keep) return undefined;
  return /\s/.test(rest) ? rest : rest.replaceAll("-", " ");
}

/** "Claude Opus 5.5" -> "Opus 5.5" and "GPT-6.1-Sol" -> "6.1 Sol" under their own provider. */
export function modelShortName(name: string, nativeFamilies: ReadonlyArray<string>): string | undefined {
  const unprefixed = name.replace(VENDOR_PREFIX, "");
  const short = withoutFamily(unprefixed, nativeFamilies) ?? (namesModel(unprefixed) ? unprefixed : name);
  return short === name ? undefined : short;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmed = qualifier?.trim();
  if (!trimmed) return value;
  const pattern = new RegExp(`^${escapeRegExp(trimmed)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

type ModelEsque = Pick<ProviderModel, "name" | "shortName" | "subProvider">;

export function getDisplayModelName(model: ModelEsque, options?: { preferShortName?: boolean }): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function resolveModelShortName(model: ModelEsque, driver: string | null | undefined): string | undefined {
  return model.shortName ?? modelShortName(model.name, (driver && MODEL_FAMILIES_BY_DRIVER[driver]) || []);
}

export function getTriggerDisplayModelName(model: ModelEsque, driver: string | null | undefined): string {
  return getDisplayModelName({ ...model, shortName: resolveModelShortName(model, driver) }, { preferShortName: true });
}

export function getProviderRowLabel(providerDisplayName: string, subProvider: string | undefined): string {
  const provider = providerDisplayName.trim();
  const sub = subProvider?.trim();
  if (!sub) return providerDisplayName;
  if (provider && new RegExp(`^${escapeRegExp(provider)}\\s+\\S`, "i").test(sub)) return sub;
  return `${providerDisplayName} · ${sub}`;
}
