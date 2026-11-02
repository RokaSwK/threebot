// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): apps/web/src/components/chat/TraitsPicker.tsx.
// The reasoning / thinking / fast mode chip and its menu. Ultrathink is an ordinary option here (T3
// injects it into the prompt instead); plan mode, agent descriptors and keybindings are left out.
import clsx from "clsx";
import { GaugeIcon, ZapIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import {
  REASONING_SELECT_DESCRIPTOR_IDS,
  buildProviderOptionSelectionsFromDescriptors,
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getSelectedTraits,
  replaceDescriptorCurrentValue,
  type SelectDescriptor,
} from "../../lib/modelTraits";
import type { ModelSelection, Provider, ProviderModel, ProviderOptionSelection } from "../../lib/types";
import { EffortGlyph, composerControlClassName, resolveEffortGlyph, type ComposerControlSize } from "./EffortGlyph";
import { Floating } from "./Floating";

/** T3's client setting `effortDisplay`: name the effort level, or draw it as bars. */
export type EffortDisplay = "label" | "bars";

function DefaultBadge() {
  return (
    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-elevated px-[3px] text-xs leading-none font-medium text-fg sm:h-4 sm:min-w-4 sm:text-[10px]">
      Default
    </span>
  );
}

/** One bolt for Fast. Ultrafast adds an outlined echo behind it, cut away by the surface color. */
function FastBolt(props: { ultra: boolean }) {
  if (!props.ultra) return <ZapIcon aria-hidden="true" className="size-3 fill-current" />;
  return (
    <span aria-hidden="true" className="relative h-3 w-[15px] shrink-0">
      <ZapIcon className="absolute top-0 left-[3px] size-3" />
      <ZapIcon strokeWidth={4} className="absolute top-0 left-0 size-3 fill-current stroke-[var(--bg-elevated)] [paint-order:stroke]" />
    </span>
  );
}

const groupLabelClassName = "px-2 pt-1.5 pb-1 text-xs font-medium text-muted";
const radioItemClassName =
  "flex min-h-8 w-full cursor-pointer items-center rounded-md px-2 py-1 text-left text-base text-fg outline-none hover:bg-hover focus-visible:bg-hover aria-checked:bg-active sm:min-h-7 sm:text-sm";

function MenuDivider() {
  return <div role="separator" className="mx-2 my-1 h-px bg-line" />;
}

function TraitsMenuContent(props: {
  model: ProviderModel | undefined;
  options: ProviderOptionSelection[] | undefined;
  onOptionsChange: (options: ProviderOptionSelection[]) => void;
}) {
  const { descriptors, selectDescriptors, booleanDescriptors } = getSelectedTraits(props.model, props.options);
  const pick = (descriptorId: string, value: string | boolean) =>
    props.onOptionsChange(buildProviderOptionSelectionsFromDescriptors(replaceDescriptorCurrentValue(descriptors, descriptorId, value)));

  return (
    <>
      {selectDescriptors.map((descriptor: SelectDescriptor, index) => {
        const selectedValue = getDescriptorStringValue(descriptor) ?? "";
        return (
          <div key={descriptor.id} role="group" aria-label={descriptor.label}>
            {index > 0 ? <MenuDivider /> : null}
            <div className={groupLabelClassName}>{descriptor.label}</div>
            {descriptor.options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={selectedValue === option.id}
                className={radioItemClassName}
                onClick={() => pick(descriptor.id, option.id)}
              >
                <span className="flex w-full min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate">{option.label}</span>
                    {option.isDefault ? <DefaultBadge /> : null}
                  </span>
                  {option.description ? <span className="max-w-56 text-xs text-pretty text-muted">{option.description}</span> : null}
                </span>
              </button>
            ))}
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";
        return (
          <div key={descriptor.id} role="group" aria-label={descriptor.label}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <div className="px-2 py-1.5 text-xs font-medium text-muted">{descriptor.label}</div>
            {(["on", "off"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={selectedValue === value}
                className={radioItemClassName}
                onClick={() => pick(descriptor.id, value === "on")}
              >
                {value === "on" ? "On" : "Off"}
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function TraitsPicker(props: {
  provider: Provider;
  model: ProviderModel | undefined;
  value: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  /** In the composer the effort reads on from the model name ("Opus 5.5 Medium"). */
  inComposer?: boolean;
  effortDisplay?: EffortDisplay;
  size?: ComposerControlSize;
  side?: "top" | "bottom";
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const { provider, model, value, inComposer = false, effortDisplay = "label", size = "sm" } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { descriptors, primarySelectDescriptor, hasAnyControls } = getSelectedTraits(model, value.options);
  if (!hasAnyControls) return null;

  const { label: triggerLabel, speedLabel, otherLabels } = buildTraitsTriggerDisplay({ driver: provider.driver, descriptors });
  const isCodexStyle = provider.driver === "codex";
  // In the composer the glyph has no word, so the tooltip and label name the control.
  const triggerDescription = inComposer ? [`Effort: ${triggerLabel}`, speedLabel].filter(Boolean).join(" · ") : triggerLabel;
  const effortGlyph =
    inComposer && primarySelectDescriptor && REASONING_SELECT_DESCRIPTOR_IDS.has(primarySelectDescriptor.id)
      ? resolveEffortGlyph(primarySelectDescriptor, getDescriptorStringValue(primarySelectDescriptor))
      : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const effortWord = effortGlyph ? (effortGlyph.special ?? (effortDisplay === "label" ? effortGlyph.label : null)) : inComposer ? triggerLabel : null;
  const iconClassName = clsx("shrink-0 text-muted", size === "xs" ? "size-3" : "size-4");

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length].focus();
    };
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(items.length - 1);
    else if (event.key === "Tab") close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerDescription}
        title={triggerDescription}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={composerControlClassName(
          size,
          clsx(
            isCodexStyle ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48" : "shrink-0 whitespace-nowrap",
            // Effort reads on from the model name: this cancels the model chip's end padding and the row gap.
            inComposer && (effortWord !== null ? "-ms-1 ps-0" : "-ms-1 ps-0.5"),
            // The word is muted next to the model name and brightens like it on hover.
            effortWord !== null && "text-muted hover:text-fg aria-expanded:text-fg",
          ),
        )}
      >
        {effortGlyph ? (
          <span className="flex items-center gap-1.5">
            {effortWord === null ? <EffortGlyph count={effortGlyph.count} filled={effortGlyph.filled} size={size} /> : null}
            {effortWord !== null ? <span>{effortWord}</span> : <span className="sr-only">{triggerLabel}</span>}
            {speedLabel === "Fast" || speedLabel === "Ultrafast" ? <FastBolt ultra={speedLabel === "Ultrafast"} /> : null}
            {otherLabels.length > 0 ? (
              <span aria-hidden="true" className="max-w-24 truncate text-xs">
                {otherLabels.join(" · ")}
              </span>
            ) : null}
          </span>
        ) : effortWord !== null ? (
          <span>{effortWord}</span>
        ) : isCodexStyle ? (
          <span className={clsx("flex w-full min-w-0 items-center", size === "xs" ? "gap-1" : "gap-1.5")}>
            <GaugeIcon aria-hidden="true" className={iconClassName} />
            <span className="min-w-0 truncate">{triggerLabel}</span>
          </span>
        ) : (
          <>
            <GaugeIcon aria-hidden="true" className={iconClassName} />
            <span>{triggerLabel}</span>
          </>
        )}
      </button>
      {open && (
        <Floating
          anchorRef={triggerRef}
          onClose={close}
          side={props.side}
          align={props.align}
          // Focus the checked level so arrow keys start from it.
          initialFocus={() => menuRef.current?.querySelector<HTMLElement>("[aria-checked=true]") ?? menuRef.current}
        >
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            aria-label="Model options"
            onKeyDown={onMenuKeyDown}
            className="scroll-thin max-h-[var(--available-height)] w-full max-w-[calc(100vw-2rem)] min-w-[min(10rem,calc(100vw-2rem))] overflow-y-auto p-1 outline-none"
          >
            <TraitsMenuContent
              model={model}
              options={value.options}
              onOptionsChange={(options) => {
                props.onChange({ instanceId: value.instanceId, model: value.model, options });
                close();
              }}
            />
          </div>
        </Floating>
      )}
    </>
  );
}
