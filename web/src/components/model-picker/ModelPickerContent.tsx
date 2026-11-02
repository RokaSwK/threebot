// Adapted from T3 Code (MIT, github.com/pingdotgg/t3code v0.1.5): apps/web/src/components/chat/ModelPickerContent.tsx.
// Search, the provider rail with Favorites, and the model list. Base UI's combobox becomes a small
// listbox here: the search box keeps focus, arrows move the highlight, Enter picks. Left out from T3:
// multi-model send, provider setup and update notices, locked providers, jump keybindings, and
// list virtualization (a provider has a dozen models at most).
import clsx from "clsx";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  applyModelPreferences,
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
  providerModelKey,
  rankModelPickerSearch,
  sortProviderModelItems,
} from "../../lib/modelPicker";
import { resolveModelShortName } from "../../lib/modelTraits";
import type { Provider, ProviderModelPreferences } from "../../lib/types";
import type { ModelFavorite } from "../../store";
import { ModelListRow, comboboxItemClassName } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  isLegacy?: boolean;
  instanceId: string;
  driver: string;
  instanceDisplayName: string;
};

// Rendered heights in 4px units. Chrome is the search box and list padding, plus a 1px border.
const ONE_LINE_ROW_UNITS = 8;
const TWO_LINE_ROW_UNITS = 12;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;
const MAX_HEIGHT = "min(346px, var(--available-height, 346px))";
const FADE = "1.5rem";

function ModelPickerList(props: { listRef: RefObject<HTMLDivElement | null>; itemKeys: ReadonlyArray<string>; children: ReactNode }) {
  const [fades, setFades] = useState({ top: false, bottom: false });
  const update = () => {
    const el = props.listRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    setFades({ top: el.scrollTop > 1, bottom: max - el.scrollTop > 1 });
  };
  const itemListKey = props.itemKeys.join("\n");
  // Measures the scroller once a new list lays out, to set its scroll fades.
  useLayoutEffect(update, [itemListKey]);
  const mask =
    fades.top && fades.bottom
      ? `linear-gradient(to bottom, transparent, black ${FADE}, black calc(100% - ${FADE}), transparent)`
      : fades.top
        ? `linear-gradient(to bottom, transparent, black ${FADE})`
        : fades.bottom
          ? `linear-gradient(to bottom, black calc(100% - ${FADE}), transparent)`
          : undefined;
  return (
    <div className={clsx("relative min-h-0 overflow-hidden pr-px", props.itemKeys.length > 0 ? "flex-1" : "h-0")}>
      <div
        ref={props.listRef}
        id="model-picker-list"
        role="listbox"
        aria-label="Models"
        onScroll={update}
        className="scroll-thin flex h-full flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-y-contain py-1.5 pr-px pl-2 [scrollbar-gutter:stable]"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {props.children}
      </div>
    </div>
  );
}

export function ModelPickerContent(props: {
  providers: ReadonlyArray<Provider>;
  preferences: ProviderModelPreferences;
  favorites: ReadonlyArray<ModelFavorite>;
  activeInstanceId: string | null;
  model: string | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSelect: (instanceId: string, slug: string) => void;
  onToggleFavorite: (instanceId: string, slug: string) => void;
}) {
  const { providers, favorites, searchInputRef } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHeight, setSearchHeight] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const highlightByKeyboard = useRef(false);

  const activeProvider = providers.find((p) => p.instanceId === props.activeInstanceId);
  const activeModel = activeProvider?.models.find((m) => m.slug === props.model);
  const activeModelKey = activeProvider && props.model ? modelPickerModelKey(activeProvider.instanceId, props.model) : null;
  const favoritesSet = new Set(favorites.map((f) => providerModelKey(f.provider, f.model)));

  const [selectedInstanceId, setSelectedInstanceId] = useState<string>(() =>
    favorites.length > 0 ? "favorites" : (activeProvider?.instanceId ?? providers[0]?.instanceId ?? "favorites"),
  );
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<string>(
        activeProvider && activeModel?.isLegacy && !favoritesSet.has(providerModelKey(activeProvider.instanceId, activeModel.slug))
          ? [activeProvider.instanceId]
          : [],
      ),
  );

  const focusSearchInput = () => searchInputRef.current?.focus({ preventScroll: true });
  const handleSelectInstance = (instanceId: string) => {
    setSelectedInstanceId(instanceId);
    setHighlight(null);
    window.requestAnimationFrame(focusSearchInput);
  };
  const toggleLegacySection = (instanceId: string) =>
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) next.delete(instanceId);
      else next.add(instanceId);
      return next;
    });

  const flatModels: ModelPickerItem[] = providers.flatMap((provider) =>
    applyModelPreferences(provider.models, props.preferences[provider.instanceId]).map((model) => {
      const shortName = resolveModelShortName(model, provider.driver);
      return {
        slug: model.slug,
        name: model.name,
        ...(shortName ? { shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        ...(model.badge ? { badge: model.badge } : {}),
        ...(model.isLegacy ? { isLegacy: true } : {}),
        instanceId: provider.instanceId,
        driver: provider.driver,
        instanceDisplayName: provider.displayName,
      };
    }),
  );

  const isSearching = searchQuery.trim().length > 0;
  // Inside one provider's tab the provider line repeats the selected rail icon on every row.
  const rowsMixProviders = isSearching || selectedInstanceId === "favorites";
  // Fit the tallest tab so switching tabs never resizes the popup and moves the rail under the cursor.
  const tallestTabUnits = (() => {
    const unitsByTab = new Map<string, number>();
    const addRow = (tab: string, twoLine: boolean) => {
      const rowUnits = twoLine ? TWO_LINE_ROW_UNITS : ONE_LINE_ROW_UNITS;
      const previous = unitsByTab.get(tab);
      unitsByTab.set(tab, previous === undefined ? rowUnits : previous + ROW_SEPARATOR_UNITS + rowUnits);
    };
    const tabsWithLegacyRow = new Set<string>();
    for (const model of flatModels) {
      const isFavorite = favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      if (isFavorite) addRow("favorites", true);
      if (model.isLegacy && !isFavorite) tabsWithLegacyRow.add(model.instanceId);
      else addRow(model.instanceId, Boolean(model.subProvider));
    }
    for (const instanceId of tabsWithLegacyRow) addRow(instanceId, true);
    return Math.max(0, ...unitsByTab.values());
  })();
  const showSidebar = !isSearching && providers.length > 0;

  const filteredModels = (() => {
    if (isSearching) {
      return rankModelPickerSearch(flatModels, searchQuery, (model) => ({
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driver: model.driver,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      }));
    }
    const result =
      selectedInstanceId === "favorites"
        ? flatModels.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)))
        : flatModels.filter((m) => m.instanceId === selectedInstanceId);
    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? providers.map((p) => p.instanceId) : [],
    });
  })();

  const legacySection = (() => {
    if (isSearching || selectedInstanceId === "favorites") return null;
    const currentModels: ModelPickerItem[] = [];
    const legacyModels: ModelPickerItem[] = [];
    for (const model of filteredModels) {
      const isLegacy = model.isLegacy && !favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      (isLegacy ? legacyModels : currentModels).push(model);
    }
    if (legacyModels.length === 0) return null;
    return {
      key: modelPickerLegacySectionKey(selectedInstanceId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyInstances.has(selectedInstanceId),
    };
  })();

  const visibleModels = legacySection ? [...legacySection.currentModels, ...(legacySection.isExpanded ? legacySection.legacyModels : [])] : filteredModels;
  const filteredItemKeys = visibleModels.map((model) => modelPickerModelKey(model.instanceId, model.slug));
  if (legacySection) filteredItemKeys.splice(legacySection.currentModels.length, 0, legacySection.key);

  // Like Base UI's autoHighlight: the selected model when it is in view, else the first match.
  const highlightedKey =
    highlight && filteredItemKeys.includes(highlight)
      ? highlight
      : !isSearching && activeModelKey && filteredItemKeys.includes(activeModelKey)
        ? activeModelKey
        : (filteredItemKeys[0] ?? null);

  // Keeps the keyboard-highlighted row in view.
  useLayoutEffect(() => {
    if (!highlightByKeyboard.current || !highlightedKey) return;
    highlightByKeyboard.current = false;
    listRef.current?.querySelector(`[data-key="${CSS.escape(highlightedKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlightedKey]);

  const pick = (key: string) => {
    const legacyInstanceId = parseModelPickerLegacySectionKey(key);
    if (legacyInstanceId) {
      toggleLegacySection(legacyInstanceId);
      return;
    }
    const model = parseModelPickerModelKey(key);
    if (model) props.onSelect(model.instanceId, model.slug);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (
      showSidebar &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) || (e.key === "Tab" && e.shiftKey))
    ) {
      const sidebar = pickerRef.current?.querySelector("[data-model-picker-sidebar]");
      const button = sidebar?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? sidebar?.querySelector<HTMLButtonElement>("button");
      if (button) {
        e.preventDefault();
        button.focus();
        return;
      }
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && filteredItemKeys.length > 0) {
      e.preventDefault();
      const index = highlightedKey ? filteredItemKeys.indexOf(highlightedKey) : -1;
      const next = (index + (e.key === "ArrowDown" ? 1 : -1) + filteredItemKeys.length) % filteredItemKeys.length;
      highlightByKeyboard.current = true;
      setHighlight(filteredItemKeys[next]);
      return;
    }
    if (e.key === "Enter" && highlightedKey) {
      e.preventDefault();
      pick(highlightedKey);
    }
  };

  const contentStyle: CSSProperties = isSearching
    ? { height: searchHeight }
    : { minHeight: `min(calc(4px * ${tallestTabUnits + LIST_CHROME_UNITS} + 1px), ${MAX_HEIGHT})` };

  return (
    <div
      ref={pickerRef}
      className="relative flex w-[calc(100vw-16px)] max-w-[360px] flex-row overflow-hidden"
      style={{ ...contentStyle, maxHeight: MAX_HEIGHT }}
      data-model-picker-content="true"
    >
      {showSidebar && (
        <ModelPickerSidebar selectedInstanceId={selectedInstanceId} onSelectInstance={handleSelectInstance} onFocusSearch={focusSearchInput} providers={providers} />
      )}

      <div className={clsx("flex min-h-0 flex-1 flex-col overflow-hidden", showSidebar && "border-l border-line")}>
        <div className="min-w-0 shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-line pb-1.5 transition-colors focus-within:border-line-strong">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-faint" />
            <input
              ref={searchInputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls="model-picker-list"
              aria-activedescendant={highlightedKey ?? undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => {
                if (!isSearching) setSearchHeight(pickerRef.current?.offsetHeight ?? 0);
                setSearchQuery(e.target.value);
                setHighlight(null);
              }}
              onKeyDown={onSearchKeyDown}
              className="h-[26px] w-full bg-transparent ps-5 font-sans text-base leading-[26px] text-fg outline-none placeholder:text-faint sm:text-sm"
            />
          </div>
        </div>

        <ModelPickerList listRef={listRef} itemKeys={filteredItemKeys}>
          {filteredItemKeys.map((key) => {
            if (legacySection?.key === key) {
              return (
                <div
                  key={key}
                  role="option"
                  id={key}
                  data-key={key}
                  aria-selected={false}
                  aria-expanded={legacySection.isExpanded}
                  data-highlighted={highlightedKey === key || undefined}
                  className={comboboxItemClassName}
                  onMouseMove={() => highlightedKey !== key && setHighlight(key)}
                  onClick={() => toggleLegacySection(selectedInstanceId)}
                >
                  <div className="min-w-0 flex-1 text-left">
                    <div className="text-sm leading-snug font-normal">Legacy models</div>
                    <div className="mt-1 text-xs leading-snug font-normal text-muted">{legacySection.legacyModels.length} models</div>
                  </div>
                  <ChevronRightIcon className={clsx("size-4 text-muted transition-transform", legacySection.isExpanded && "rotate-90")} />
                </div>
              );
            }
            const model = visibleModels.find((m) => modelPickerModelKey(m.instanceId, m.slug) === key);
            if (!model) return null;
            return (
              <ModelListRow
                key={key}
                itemKey={key}
                slug={model.slug}
                name={model.name}
                subProvider={model.subProvider}
                instanceId={model.instanceId}
                driver={model.driver}
                providerDisplayName={model.instanceDisplayName}
                isFavorite={favoritesSet.has(providerModelKey(model.instanceId, model.slug))}
                isSelected={key === activeModelKey}
                isHighlighted={key === highlightedKey}
                showProvider={rowsMixProviders || Boolean(model.subProvider)}
                showNewBadge={model.badge === "new"}
                onSelect={props.onSelect}
                onHighlight={setHighlight}
                onToggleFavorite={props.onToggleFavorite}
              />
            );
          })}
        </ModelPickerList>
        {filteredItemKeys.length === 0 && (
          <div className="p-2 text-center text-base text-muted sm:text-sm">{selectedInstanceId === "favorites" && !isSearching ? "No favorites yet" : "No models found"}</div>
        )}
      </div>
    </div>
  );
}
