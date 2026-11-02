// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): apps/web/src/components/chat/ModelListRow.tsx.
import clsx from "clsx";
import { CheckIcon, StarIcon } from "lucide-react";
import { memo } from "react";
import { getDisplayModelName, getProviderRowLabel } from "../../lib/modelTraits";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** One option row: T3's ComboboxItem look (selected 6%, highlighted 9% tint) on this app's tokens. */
export const comboboxItemClassName =
  "group relative flex min-h-8 w-full min-w-0 shrink-0 cursor-pointer items-center rounded-md px-2 py-1 text-left text-base outline-none data-[selected]:bg-hover data-[highlighted]:bg-active sm:min-h-7 sm:text-sm";

export const ModelListRow = memo(function ModelListRow(props: {
  itemKey: string;
  slug: string;
  name: string;
  subProvider?: string;
  instanceId: string;
  driver: string;
  providerDisplayName: string;
  isFavorite: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  showProvider: boolean;
  showNewBadge?: boolean;
  onSelect: (instanceId: string, slug: string) => void;
  onHighlight: (key: string) => void;
  onToggleFavorite: (instanceId: string, slug: string) => void;
}) {
  const providerLabel = getProviderRowLabel(props.providerDisplayName, props.subProvider);
  return (
    <div
      role="option"
      id={props.itemKey}
      data-key={props.itemKey}
      aria-selected={props.isSelected}
      data-selected={props.isSelected || undefined}
      data-highlighted={props.isHighlighted || undefined}
      className={comboboxItemClassName}
      onMouseMove={() => !props.isHighlighted && props.onHighlight(props.itemKey)}
      onClick={() => props.onSelect(props.instanceId, props.slug)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 truncate text-sm leading-snug font-normal">{getDisplayModelName(props)}</div>
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded border border-accent/35 bg-accent/15 px-0.5 py-px text-[9px] leading-none font-bold tracking-wide text-accent uppercase"
                aria-label="New model"
              >
                New
              </span>
            ) : null}
          </div>
          {props.showProvider && (
            <div className="mt-1 flex items-center gap-1.5">
              <ProviderInstanceIcon driver={props.driver} displayName={props.providerDisplayName} className="size-3 text-muted" iconClassName="size-3" />
              <span className="truncate text-xs leading-snug font-normal text-faint">{providerLabel}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            tabIndex={-1}
            className="-mr-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg sm:size-6"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleFavorite(props.instanceId, props.slug);
            }}
            aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
            title={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <StarIcon
              className={clsx(
                "size-3.5 sm:size-3",
                props.isFavorite
                  ? "fill-current text-attention"
                  : "opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 pointer-coarse:opacity-100",
              )}
            />
          </button>
          {/* Last, and always reserved, so stars and the check keep fixed columns. */}
          <CheckIcon className={clsx("size-3.5 text-muted", !props.isSelected && "invisible")} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
});
