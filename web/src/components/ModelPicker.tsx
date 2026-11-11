// Threebot's own model selector. It lists T3's providers and models and writes a T3 model selection,
// so a choice here is the same choice in T3 Code.
import clsx from "clsx";
import { Check, ChevronRight, Star } from "lucide-react";
import { useState } from "react";
import { applyModelPreferences, rankModelPickerSearch } from "../lib/modelPicker";
import {
  buildProviderOptionSelectionsFromDescriptors,
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getDisplayModelName,
  getSelectedTraits,
  getTriggerDisplayModelName,
  replaceDescriptorCurrentValue,
  selectionForModel,
} from "../lib/modelTraits";
import type { ModelSelection, Provider, ProviderModel } from "../lib/types";
import { useApp } from "../store";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Modal, Switch } from "./ui";

const FAVORITES_KEY = "threebot:favorite-models";

function readFavoriteKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeFavoriteKeys(keys: Set<string>) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(keys)));
  } catch {}
}

export function ModelPicker({ value, onChange }: { value: ModelSelection | null; onChange: (selection: ModelSelection) => void }) {
  const providers = useApp((s) => s.providers);
  const [open, setOpen] = useState(false);
  const provider = providers.find((p) => p.instanceId === value?.instanceId);
  const model = provider?.models.find((m) => m.slug === value?.model);
  const traits = provider && model ? buildTraitsTriggerDisplay({ driver: provider.driver, descriptors: getSelectedTraits(model, value?.options).descriptors }).label : "";
  return <>
    <button type="button" className="model-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {provider && <ProviderInstanceIcon driver={provider.driver} displayName={provider.displayName} className="size-4 text-muted" iconClassName="size-4" />}
      <span className="name">{model ? getTriggerDisplayModelName(model, provider?.driver) : value?.model || "Choose a model"}</span>
      {traits && <span className="traits">{traits}</span>}
      <ChevronRight size={15} className="go" />
    </button>
    {open && <ModelSheet providers={providers} value={value} onChange={onChange} onClose={() => setOpen(false)} />}
  </>;
}

type ListedItem = {
  model: ProviderModel;
  instanceId: string;
  driver: string;
  displayName: string;
};

function ModelSheet({ providers, value, onChange, onClose }: { providers: Provider[]; value: ModelSelection | null; onChange: (selection: ModelSelection) => void; onClose: () => void }) {
  const preferences = useApp((s) => s.providerModelPreferences);
  const [activeTab, setActiveTab] = useState<string>(value?.instanceId ?? providers[0]?.instanceId ?? "favorites");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => readFavoriteKeys());

  const toggleFavorite = (instId: string, slug: string) => {
    const key = `${instId}:${slug}`;
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeFavoriteKeys(next);
      return next;
    });
  };

  const isFavorite = (instId: string, slug: string) => favorites.has(`${instId}:${slug}`);

  // Determine items to display
  let items: ListedItem[] = [];
  if (activeTab === "favorites") {
    for (const p of providers) {
      for (const m of p.models) {
        if (isFavorite(p.instanceId, m.slug)) {
          items.push({ model: m, instanceId: p.instanceId, driver: p.driver, displayName: p.displayName });
        }
      }
    }
    if (query.trim()) {
      items = rankModelPickerSearch(items, query, (it) => ({
        driver: it.driver,
        providerDisplayName: it.displayName,
        name: it.model.name,
        shortName: it.model.shortName,
        subProvider: it.model.subProvider,
        isFavorite: true,
      }));
    }
  } else {
    const provider = providers.find((p) => p.instanceId === activeTab) ?? providers[0];
    const listed = provider ? applyModelPreferences(provider.models, preferences[provider.instanceId]) : [];
    const ranked = query.trim()
      ? rankModelPickerSearch(listed, query, (m) => ({
          driver: provider?.driver ?? "",
          providerDisplayName: provider?.displayName ?? "",
          name: m.name,
          shortName: m.shortName,
          subProvider: m.subProvider,
          isFavorite: isFavorite(provider?.instanceId ?? "", m.slug),
        }))
      : listed;
    items = ranked.map((m) => ({
      model: m,
      instanceId: provider?.instanceId ?? "",
      driver: provider?.driver ?? "",
      displayName: provider?.displayName ?? "",
    }));
  }

  // Active/selected model for traits
  const currentProvider = providers.find((p) => p.instanceId === value?.instanceId);
  const currentModel = currentProvider?.models.find((m) => m.slug === value?.model);
  const { descriptors, selectDescriptors, booleanDescriptors } = getSelectedTraits(currentModel, value?.options);
  const hasTraits = selectDescriptors.length > 0 || booleanDescriptors.length > 0;

  const pick = (next: ProviderModel, targetInstanceId: string) => {
    const targetProvider = providers.find((p) => p.instanceId === targetInstanceId);
    if (!targetProvider || (targetProvider.instanceId === value?.instanceId && next.slug === value?.model)) return;
    onChange(selectionForModel(targetProvider.instanceId, next, next.slug, targetProvider.instanceId === value?.instanceId ? value?.options : undefined));
  };

  const setTrait = (id: string, trait: string | boolean) => {
    if (value) {
      onChange({
        ...value,
        options: buildProviderOptionSelectionsFromDescriptors(replaceDescriptorCurrentValue(descriptors, id, trait)),
      });
    }
  };

  return (
    <Modal onClose={onClose} title="Model" className={clsx("model-sheet w-full max-w-[calc(100vw-2rem)]", hasTraits ? "sm:w-[620px]" : "sm:w-[460px]")}>
      <div className="dialog-body flex flex-col sm:flex-row h-[480px] max-h-[75vh] p-0 overflow-hidden">
        {/* Left vertical sidebar (desktop) */}
        {providers.length > 1 && (
          <div className="hidden sm:flex flex-col w-12 shrink-0 border-r border-line bg-[var(--bg-card)]/40 p-1.5 gap-1.5 items-center" role="tablist" aria-label="Providers">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "favorites"}
              className={clsx(
                "model-sidebar-btn model-tab size-9 rounded-xl flex items-center justify-center transition-colors",
                activeTab === "favorites" ? "bg-[var(--pill)] text-[var(--pill-fg)] shadow-xs" : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
              )}
              onClick={() => { setActiveTab("favorites"); setQuery(""); }}
              title="Favorites"
              aria-label="Favorites"
            >
              <Star size={17} className={activeTab === "favorites" ? "fill-current" : ""} />
              <span className="sr-only">Favorites</span>
            </button>
            <div className="w-5 h-px bg-line my-0.5" />
            {providers.map((p) => {
              const isSelected = activeTab === p.instanceId;
              return (
                <button
                  key={p.instanceId}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={clsx(
                    "model-sidebar-btn model-tab size-9 rounded-xl flex items-center justify-center transition-colors",
                    isSelected ? "bg-[var(--pill)] text-[var(--pill-fg)] shadow-xs" : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
                  )}
                  onClick={() => { setActiveTab(p.instanceId); setQuery(""); }}
                  title={p.displayName}
                  aria-label={p.displayName}
                >
                  <ProviderInstanceIcon driver={p.driver} displayName={p.displayName} className="size-5" iconClassName="size-5" />
                  <span className="sr-only">{p.displayName}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Mobile top tabs */}
        {providers.length > 1 && (
          <div className="flex sm:hidden overflow-x-auto p-2 border-b border-line gap-1.5 shrink-0" role="tablist" aria-label="Providers">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "favorites"}
              className={clsx(
                "model-mobile-tab model-tab inline-flex h-8 items-center gap-1.5 px-3 rounded-full text-xs transition-colors shrink-0",
                activeTab === "favorites" ? "bg-[var(--pill)] text-[var(--pill-fg)] font-medium" : "bg-[var(--bg-card)] text-muted hover:bg-[var(--bg-hover)]"
              )}
              onClick={() => { setActiveTab("favorites"); setQuery(""); }}
            >
              <Star size={13} className={activeTab === "favorites" ? "fill-current" : ""} />
              <span>Favorites</span>
            </button>
            {providers.map((p) => {
              const isSelected = activeTab === p.instanceId;
              return (
                <button
                  key={p.instanceId}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={clsx(
                    "model-mobile-tab model-tab inline-flex h-8 items-center gap-1.5 px-3 rounded-full text-xs transition-colors shrink-0",
                    isSelected ? "bg-[var(--pill)] text-[var(--pill-fg)] font-medium" : "bg-[var(--bg-card)] text-muted hover:bg-[var(--bg-hover)]"
                  )}
                  onClick={() => { setActiveTab(p.instanceId); setQuery(""); }}
                >
                  <ProviderInstanceIcon driver={p.driver} displayName={p.displayName} className="size-3.5" iconClassName="size-3.5" />
                  <span>{p.displayName}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Center: Search + Models */}
        <div className="flex-1 min-w-0 flex flex-col p-3 gap-2 overflow-hidden">
          <input
            className="model-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            aria-label="Search models"
          />
          <div className="model-list flex-1 overflow-y-auto" role="radiogroup" aria-label="Models">
            {items.map(({ model, instanceId: itemInstId, driver: itemDriver, displayName: itemDisplayName }) => {
              const selected = itemInstId === value?.instanceId && model.slug === value?.model;
              const fav = isFavorite(itemInstId, model.slug);
              const showIcon = activeTab === "favorites";
              return (
                <div key={`${itemInstId}:${model.slug}`} className="model-row-item group flex items-center gap-1 w-full rounded-xl hover:bg-[var(--bg-hover)] transition-colors pr-1.5">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={clsx(
                      "model-row flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 text-left rounded-xl transition-colors",
                      selected && "bg-[var(--bg-active)]"
                    )}
                    onClick={() => pick(model, itemInstId)}
                  >
                    {showIcon && (
                      <ProviderInstanceIcon driver={itemDriver} displayName={itemDisplayName} className="size-4 shrink-0 text-muted" iconClassName="size-4" />
                    )}
                    <span className="model-name truncate min-w-0 flex-1">{getDisplayModelName(model)}</span>
                    {model.subProvider && (
                      <span className="model-subprovider shrink-0 truncate text-xs text-muted/75">{model.subProvider}</span>
                    )}
                    {selected && <Check size={14} className="ml-auto shrink-0 text-primary" />}
                  </button>
                  <button
                    type="button"
                    className={clsx(
                      "model-star shrink-0 p-1.5 rounded-lg transition-all",
                      fav ? "text-amber-400 opacity-100" : "text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-foreground"
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(itemInstId, model.slug);
                    }}
                    aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                    title={fav ? "Remove from favorites" : "Add to favorites"}
                  >
                    <Star size={14} className={fav ? "fill-amber-400" : ""} />
                  </button>
                </div>
              );
            })}
            {activeTab === "favorites" && items.length === 0 && (
              <div className="flex flex-col items-center justify-center p-8 text-center text-muted gap-2">
                <Star size={24} className="opacity-40" />
                <span className="text-sm font-medium">No favorite models yet</span>
                <span className="text-xs max-w-[240px]">Star any model in a provider's list to quickly find it here.</span>
              </div>
            )}
            {query.trim() && items.length === 0 && activeTab !== "favorites" && (
              <div className="flex flex-col items-center justify-center p-8 text-center text-muted gap-2">
                <span className="text-sm">No models found for "{query}"</span>
              </div>
            )}
          </div>

          {/* Mobile bottom traits */}
          {hasTraits && (
            <div className="sm:hidden border-t border-line pt-2.5 mt-1 flex flex-col gap-2 shrink-0">
              <div className="text-xs font-medium text-muted">
                {currentModel ? getDisplayModelName(currentModel) : "Options"}
              </div>
              {selectDescriptors.map((descriptor) => (
                <div key={descriptor.id} className="flex flex-col gap-1">
                  <span className="text-xs text-muted">{descriptor.label}</span>
                  <div className="model-choices flex flex-wrap gap-1.5">
                    {descriptor.options.map((option) => {
                      const active = getDescriptorStringValue(descriptor) === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={clsx("model-choice", active && "active")}
                          aria-pressed={active}
                          onClick={() => setTrait(descriptor.id, option.id)}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {booleanDescriptors.map((descriptor) => (
                <div key={descriptor.id} className="model-switch flex items-center justify-between py-1 text-xs">
                  <span className="text-muted-foreground">{descriptor.label}</span>
                  <Switch checked={descriptor.currentValue === true} onChange={(checked) => setTrait(descriptor.id, checked)} label={descriptor.label} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right traits panel (desktop) */}
        {hasTraits && (
          <div className="model-traits-col hidden sm:flex flex-col w-52 shrink-0 border-l border-line p-3 gap-3 overflow-y-auto bg-[var(--bg-card)]/20">
            <div className="text-xs font-semibold text-muted tracking-wide uppercase px-1">
              {currentModel ? getDisplayModelName(currentModel) : "Options"}
            </div>
            {selectDescriptors.map((descriptor) => (
              <div key={descriptor.id} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted px-1">{descriptor.label}</span>
                <div className="flex flex-col gap-0.5">
                  {descriptor.options.map((option) => {
                    const active = getDescriptorStringValue(descriptor) === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={clsx(
                          "model-trait-row flex items-center justify-between w-full px-2.5 py-1.5 rounded-lg text-xs transition-colors text-left",
                          active ? "bg-[var(--pill)] text-[var(--pill-fg)] font-medium" : "hover:bg-[var(--bg-hover)] text-muted-foreground"
                        )}
                        onClick={() => setTrait(descriptor.id, option.id)}
                      >
                        <span>{option.label}</span>
                        <div className="flex items-center gap-1.5">
                          {option.isDefault && (
                            <span className={clsx("text-[10px] uppercase tracking-wider", active ? "opacity-75" : "text-muted")}>
                              Default
                            </span>
                          )}
                          {active && <Check size={13} className="shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {booleanDescriptors.map((descriptor) => (
              <div key={descriptor.id} className="model-switch flex items-center justify-between px-1 py-1 text-xs">
                <span className="text-muted-foreground">{descriptor.label}</span>
                <Switch checked={descriptor.currentValue === true} onChange={(checked) => setTrait(descriptor.id, checked)} label={descriptor.label} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
