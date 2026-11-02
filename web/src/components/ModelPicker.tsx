// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): how ComposerFooterControls.tsx pairs
// the model chip with the traits chip. Used by the composer, the New Bot dialog and Settings.
import clsx from "clsx";
import { selectionForModel } from "../lib/modelTraits";
import type { ModelSelection } from "../lib/types";
import { toggleModelFavorite, useApp } from "../store";
import { ProviderModelPicker } from "./model-picker/ProviderModelPicker";
import { TraitsPicker } from "./model-picker/TraitsPicker";

export function ModelPicker({
  value,
  onChange,
  align = "start",
  side = "bottom",
  inComposer = false,
  className,
}: {
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  /** Which trigger edge the popups line up with. */
  align?: "start" | "end";
  /** Preferred popup side; it flips when the other side has more room. */
  side?: "top" | "bottom";
  inComposer?: boolean;
  className?: string;
}) {
  const providers = useApp((s) => s.providers);
  const preferences = useApp((s) => s.providerModelPreferences);
  const favorites = useApp((s) => s.modelFavorites);
  const provider = providers.find((p) => p.instanceId === value?.instanceId);
  const model = provider?.models.find((m) => m.slug === value?.model);

  const selectModel = (instanceId: string, slug: string) => {
    if (instanceId === value?.instanceId && slug === value.model) return;
    const next = providers.find((p) => p.instanceId === instanceId)?.models.find((m) => m.slug === slug);
    onChange(selectionForModel(instanceId, next, slug, instanceId === value?.instanceId ? value.options : undefined));
  };

  return (
    <div className={clsx("flex min-w-0 items-center gap-1", className)}>
      <ProviderModelPicker
        providers={providers}
        preferences={preferences}
        favorites={favorites}
        provider={provider}
        model={model}
        modelSlug={value?.model ?? null}
        onSelect={selectModel}
        onToggleFavorite={toggleModelFavorite}
        inComposer={inComposer}
        side={side}
        align={align}
      />
      {value && provider && model && <TraitsPicker provider={provider} model={model} value={value} onChange={onChange} inComposer={inComposer} side={side} align={align} />}
    </div>
  );
}
