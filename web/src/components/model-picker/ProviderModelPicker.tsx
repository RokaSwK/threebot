// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): apps/web/src/components/chat/ProviderModelPicker.tsx.
// The model chip (provider icon + short model name) and its popup.
import clsx from "clsx";
import { useRef, useState } from "react";
import { getDisplayModelName, getTriggerDisplayModelName } from "../../lib/modelTraits";
import type { Provider, ProviderModel, ProviderModelPreferences } from "../../lib/types";
import type { ModelFavorite } from "../../store";
import { composerControlClassName, type ComposerControlSize } from "./EffortGlyph";
import { Floating, isCoarsePointer } from "./Floating";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function ProviderModelPicker(props: {
  providers: ReadonlyArray<Provider>;
  preferences: ProviderModelPreferences;
  favorites: ReadonlyArray<ModelFavorite>;
  provider: Provider | undefined;
  model: ProviderModel | undefined;
  /** The selected slug, shown as is when T3 no longer lists the model. */
  modelSlug: string | null;
  onSelect: (instanceId: string, slug: string) => void;
  onToggleFavorite: (instanceId: string, slug: string) => void;
  inComposer?: boolean;
  size?: ComposerControlSize;
  side?: "top" | "bottom";
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const { provider, model, size = "sm" } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const triggerTitle = model ? getTriggerDisplayModelName(model, provider?.driver) : props.modelSlug || "Choose model";
  const triggerLabel = model ? getDisplayModelName(model) : triggerTitle;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((v) => !v)}
        className={composerControlClassName(
          size,
          clsx("min-w-0 shrink justify-between whitespace-nowrap", props.inComposer ? "max-w-40 sm:max-w-56" : "max-w-48 sm:max-w-56"),
        )}
      >
        <span className={clsx("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}>
          {provider ? (
            // Narrow composers hide the provider icon before truncating the name.
            <span className={clsx("contents", props.inComposer && "max-sm:hidden")}>
              <ProviderInstanceIcon driver={provider.driver} displayName={provider.displayName} className="size-4 text-muted" iconClassName="size-4" />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{triggerTitle}</span>
        </span>
      </button>
      {open && (
        <Floating
          anchorRef={triggerRef}
          onClose={close}
          side={props.side}
          align={props.align}
          lockScroll
          // T3 focuses search on open; on touch screens that would raise the keyboard over the list.
          initialFocus={() => (isCoarsePointer() ? null : searchInputRef.current)}
        >
          <ModelPickerContent
            providers={props.providers}
            preferences={props.preferences}
            favorites={props.favorites}
            activeInstanceId={provider?.instanceId ?? null}
            model={props.modelSlug}
            searchInputRef={searchInputRef}
            onSelect={(instanceId, slug) => {
              if (props.disabled) return;
              props.onSelect(instanceId, slug);
              close();
            }}
            onToggleFavorite={props.onToggleFavorite}
          />
        </Floating>
      )}
    </>
  );
}
