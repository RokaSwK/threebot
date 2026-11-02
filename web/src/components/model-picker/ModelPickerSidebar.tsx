// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): apps/web/src/components/chat/ModelPickerSidebar.tsx.
// The provider rail: Favorites, then one icon per provider, with a bar marking the open tab.
import { StarIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Provider } from "../../lib/types";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const railButtonClassName =
  "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-fg/10 focus-visible:bg-fg/10 focus-visible:outline-none";

export function ModelPickerSidebar(props: {
  selectedInstanceId: string;
  onSelectInstance: (instanceId: string) => void;
  onFocusSearch: () => void;
  providers: ReadonlyArray<Provider>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  // Reads the selected item's offset to position the selection indicator.
  useLayoutEffect(() => {
    const item = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-model-picker-provider]") ?? []).find(
      (el) => el.dataset.modelPickerProvider === props.selectedInstanceId,
    );
    setIndicatorTop(item ? item.offsetTop + item.offsetHeight / 2 - 10 : null);
  }, [props.providers, props.selectedInstanceId]);

  // A vertical toolbar: arrows move between buttons, ArrowRight returns to the search box.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      props.onFocusSearch();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    buttons[next]?.focus();
  };

  const button = (id: string, label: string, content: ReactNode) => (
    <div key={id} className="relative w-full" data-model-picker-provider={id}>
      <button
        type="button"
        className={railButtonClassName}
        onClick={() => props.onSelectInstance(id)}
        aria-label={label}
        title={label}
        aria-pressed={props.selectedInstanceId === id}
        tabIndex={props.selectedInstanceId === id ? 0 : -1}
      >
        {content}
      </button>
    </div>
  );

  return (
    <div role="toolbar" aria-orientation="vertical" aria-label="Providers" data-model-picker-sidebar="true" className="w-11 shrink-0 overflow-hidden bg-card" onKeyDown={onKeyDown}>
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={contentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {indicatorTop !== null ? (
            <div
              className="pointer-events-none absolute right-1 z-10 h-5 w-[3px] rounded-full bg-fg transition-[top] duration-200 ease-out"
              style={{ top: indicatorTop }}
            />
          ) : null}
          {button("favorites", "Favorites", <StarIcon className="size-5 shrink-0 fill-current" aria-hidden />)}
          <div className="border-b border-line" aria-hidden="true" />
          {props.providers.map((provider) =>
            button(
              provider.instanceId,
              provider.displayName,
              <ProviderInstanceIcon driver={provider.driver} displayName={provider.displayName} className="z-30 size-6" iconClassName="size-5" />,
            ),
          )}
        </div>
      </div>
    </div>
  );
}
