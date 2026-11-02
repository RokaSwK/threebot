// Threebot's own model selector. It lists T3's providers and models and writes a T3 model selection,
// so a choice here is the same choice in T3 Code.
import { Check, ChevronRight } from "lucide-react";
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

const SEARCH_FROM = 12;

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

function ModelSheet({ providers, value, onChange, onClose }: { providers: Provider[]; value: ModelSelection | null; onChange: (selection: ModelSelection) => void; onClose: () => void }) {
  const preferences = useApp((s) => s.providerModelPreferences);
  const [instanceId, setInstanceId] = useState(value?.instanceId ?? providers[0]?.instanceId);
  const [query, setQuery] = useState("");
  const provider = providers.find((p) => p.instanceId === instanceId);
  const listed = provider ? applyModelPreferences(provider.models, preferences[provider.instanceId]) : [];
  const models = query.trim()
    ? rankModelPickerSearch(listed, query, (model) => ({ driver: provider?.driver ?? "", providerDisplayName: provider?.displayName ?? "", name: model.name, shortName: model.shortName, subProvider: model.subProvider }))
    : listed;
  const current = providers.find((p) => p.instanceId === value?.instanceId)?.models.find((m) => m.slug === value?.model);
  const { descriptors, selectDescriptors, booleanDescriptors } = getSelectedTraits(current, value?.options);
  const pick = (next: ProviderModel) => {
    if (!provider || (provider.instanceId === value?.instanceId && next.slug === value.model)) return;
    onChange(selectionForModel(provider.instanceId, next, next.slug, provider.instanceId === value?.instanceId ? value.options : undefined));
  };
  const setTrait = (id: string, trait: string | boolean) => {
    if (value) onChange({ ...value, options: buildProviderOptionSelectionsFromDescriptors(replaceDescriptorCurrentValue(descriptors, id, trait)) });
  };
  return <Modal onClose={onClose} title="Model" className="model-sheet w-[420px]">
    <div className="dialog-body">
      {providers.length > 1 && <div className="model-tabs" role="tablist" aria-label="Providers">
        {providers.map((p) => <button key={p.instanceId} type="button" role="tab" aria-selected={p.instanceId === instanceId} className="model-tab" onClick={() => { setInstanceId(p.instanceId); setQuery(""); }}>
          <ProviderInstanceIcon driver={p.driver} displayName={p.displayName} className="size-4" iconClassName="size-4" />{p.displayName}
        </button>)}
      </div>}
      {listed.length >= SEARCH_FROM && <input className="model-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models" aria-label="Search models" />}
      <div className="model-list" role="radiogroup" aria-label="Models">
        {models.map((model) => {
          const selected = provider?.instanceId === value?.instanceId && model.slug === value?.model;
          return <button key={model.slug} type="button" role="radio" aria-checked={selected} className="model-row" onClick={() => pick(model)}>{getDisplayModelName(model)}{selected && <Check size={15} />}</button>;
        })}
      </div>
      {selectDescriptors.map((descriptor) => <section key={descriptor.id} className="model-trait">
        <h3>{descriptor.label}</h3>
        <div className="model-choices">
          {descriptor.options.map((option) => <button key={option.id} type="button" className="model-choice" aria-pressed={getDescriptorStringValue(descriptor) === option.id} onClick={() => setTrait(descriptor.id, option.id)}>{option.label}</button>)}
        </div>
      </section>)}
      {booleanDescriptors.map((descriptor) => <div key={descriptor.id} className="model-switch">
        <span>{descriptor.label}</span>
        <Switch checked={descriptor.currentValue === true} onChange={(checked) => setTrait(descriptor.id, checked)} label={descriptor.label} />
      </div>)}
    </div>
  </Modal>;
}
