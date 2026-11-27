import { useState } from "react";
import { deploymentFields, hasHarnessRouteConfirmation, sameBinding, validateMappingRows } from "../../../src/channel-bindings.js";
import { Field } from "./ui.jsx";
import { newChannelId } from "../utils.js";
import { copilotIdentity, isCopilotChannel, matchesDiscoveredRoutes } from "../copilot.js";
import OpenAIChannelDiscovery, { canDiscoverOpenAIChannel } from "./OpenAIChannelDiscovery.jsx";

export function migrateChannel(config, index, channelId, capabilityView) {
  const up = config.upstreams[index];
  const mappings = new Map();
  for (const model of config.models.filter(m => !m.selectedBinding && m.upstream === up.name)) {
    const sourceModelId = model.targetModel || model.id;
    const canonicalModelId = capabilityView?.models.find(entry => entry.modelId === model.id)?.canonicalModelId;
    if (!canonicalModelId || (mappings.has(sourceModelId) && mappings.get(sourceModelId).canonicalModelId !== canonicalModelId)) {
      throw new Error(`${model.id}: ${sourceModelId}`);
    }
    mappings.set(sourceModelId, { sourceModelId, canonicalModelId, enabled: true });
    const ref = { channelId, sourceModelId };
    const override = {};
    for (const field of [...deploymentFields, "pricingRef"]) {
      const value = model[field];
      if (field === "pricingRef" ? value !== canonicalModelId : value && Object.keys(value).length) {
        if (value !== undefined) override[field] = value;
      }
      delete model[field];
    }
    if (Object.keys(override).length) model.bindingOverride = { ...ref, ...override };
    delete model.targetModel;
    delete model.upstream;
    Object.assign(model, { canonicalModelId, selectedBinding: ref });
    if (hasHarnessRouteConfirmation(model)) model.confirmedRouteBinding = ref;
  }
  Object.assign(up, { channelId, modelMappings: [...mappings.values()] });
}

export function MappingEditor({ up, saved, index, config, capabilityView, definitions, updateConfig, drafts, setDrafts, t }) {
  const [migrationError, setMigrationError] = useState("");
  const id = up.channelId;
  const draft = Object.hasOwn(drafts, id) ? drafts[id] : null;
  const rows = up.modelMappings || [];
  const tableEditable = Array.isArray(rows) && rows.every(row => row && typeof row === "object" && !Array.isArray(row));
  const ids = new Set(definitions.map(card => card.id));
  const writeRows = change => updateConfig(next => change(next.upstreams[index].modelMappings));
  const clearDraft = () => setDrafts(previous => {
    const next = { ...previous };
    delete next[id];
    return next;
  });
  if (!id) return <div>
    <button type="button" className="ghost" disabled={!capabilityView && config.models?.some(m => m.upstream === up.name)}
      onClick={() => {
        const next = structuredClone(config);
        try {
          migrateChannel(next, index, newChannelId(), capabilityView);
          validateMappingRows(next.upstreams[index].modelMappings, "modelMappings", ids);
        } catch (error) {
          setMigrationError(`${t("channel.migrateFailed")}: ${error.message}`);
          return;
        }
        updateConfig(d => { d.models = next.models; d.upstreams[index] = next.upstreams[index]; });
      }}>{t("channel.migrate")}</button>
    {migrationError && <p role="alert">{migrationError}</p>}
  </div>;
  let issue = "";
  let parsed;
  try {
    parsed = draft ? JSON.parse(draft.text) : rows;
    validateMappingRows(parsed, "modelMappings", ids);
    if (draft && draft.base !== JSON.stringify(rows)) issue = t("channel.stale");
  } catch (error) { issue = error.message; }
  return <fieldset><legend>{t("channel.mappings")}</legend>
    <p>{t("channel.manual")} <code>{id}</code></p>
    {draft ? <>
      <Field label={t("channel.json")}><textarea rows={9} value={draft.text} onChange={event => {
        const text = event.target.value;
        setDrafts(previous => ({ ...previous, [id]: { ...draft, text } }));
      }} /></Field>
      <button type="button" disabled={!!issue} onClick={() => {
        updateConfig(next => { next.upstreams[index].modelMappings = parsed; });
        clearDraft();
      }}>{t("channel.useJson")}</button>
      <button type="button" className="ghost" onClick={clearDraft}>{t("channel.cancelJson")}</button>
    </> : <>
      {tableEditable && canDiscoverOpenAIChannel(up, saved) &&
        <OpenAIChannelDiscovery up={up} saved={saved} definitions={definitions} updateConfig={updateConfig} t={t} />}
      {tableEditable && rows.map((row, i) => <div className="form-grid compact" key={i}>
        <Field label={t("channel.source")}><input value={row.sourceModelId} onChange={e => {
          const value = e.target.value;
          writeRows(list => { list[i].sourceModelId = value; });
        }} /></Field>
        <Field label={t("channel.canonical")}><select value={row.canonicalModelId} onChange={e => {
          const value = e.target.value;
          writeRows(list => { list[i].canonicalModelId = value; });
        }}><option value="">—</option>{definitions.map(card => <option key={card.id}>{card.id}</option>)}</select></Field>
        <label><input type="checkbox" checked={row.enabled} onChange={e => {
          const checked = e.target.checked;
          writeRows(list => { list[i].enabled = checked; });
        }} /> {t("channel.enabled")}</label>
        <button type="button" className="ghost" onClick={() => writeRows(list => list.splice(i, 1))}>{t("entity.delete", "Delete")}</button>
      </div>)}
      <div className="toolbar-cluster">
        <button type="button" disabled={!tableEditable} onClick={() => writeRows(list => list.push({ sourceModelId: "", canonicalModelId: "", enabled: false }))}>{t("channel.addRow")}</button>
        {tableEditable && rows.length > 0 && <button type="button" className="ghost" onClick={() => {
          const enabled = !rows.every(row => row.enabled);
          writeRows(list => list.forEach(row => { row.enabled = enabled; }));
        }}>{rows.every(row => row.enabled) ? t("channel.disableAll") : t("channel.enableAll")}</button>}
        <button type="button" className="ghost" onClick={() => setDrafts(previous => ({
          ...previous, [id]: { text: JSON.stringify(rows, null, 2), base: JSON.stringify(rows) }
        }))}>{t("channel.json")}</button>
      </div>
    </>}
    {issue && <p role="alert">{issue}</p>}
  </fieldset>;
}

export function channelCandidates(upstreams, definitions, evidence) {
  const groups = new Map();
  const ids = new Set(definitions.map(card => card.id));
  for (const up of upstreams) {
    if (!Array.isArray(up.modelMappings)) continue;
    const copilot = isCopilotChannel(up);
    const discovered = copilot && evidence?.get(copilotIdentity(up));
    let issue = "";
    try { validateMappingRows(up.modelMappings, "modelMappings", ids); } catch (error) { issue = error.message; }
    for (const row of up.modelMappings) {
      if (!row?.canonicalModelId) continue;
      const list = groups.get(row.canonicalModelId) || [];
      list.push({ ref: { channelId: up.channelId, sourceModelId: row.sourceModelId },
        label: `${up.name} → ${row.sourceModelId}`, issue, available: !issue && row.enabled && up.status !== "disabled"
          && (!copilot || matchesDiscoveredRoutes(row, discovered?.get(row.sourceModelId))) });
      groups.set(row.canonicalModelId, list);
    }
  }
  return groups;
}

export function BindingSelect({ choices, value, onChange, t }) {
  const key = ref => JSON.stringify([ref.channelId, ref.sourceModelId]);
  return <Field label={t("channel.binding")}><select value={value ? key(value) : ""} onChange={e => {
    const choice = choices.find(c => key(c.ref) === e.target.value);
    if (choice?.available) onChange(choice.ref);
  }}><option value="">—</option>
    {choices.map((choice, i) => <option key={i} value={key(choice.ref)} disabled={!choice.available}>
      {choice.label}{!choice.available && ` (${choice.issue || t("channel.unavailable")})`}
    </option>)}
  </select></Field>;
}

export function ExposurePicker({ groups, models, search, updateConfig, t }) {
  const [selections, setSelections] = useState(new Map());
  const [filter, setFilter] = useState("all");
  const pending = [];
  const removals = new Set();
  const rows = [];
  for (const [canonicalModelId, choices] of groups) {
    const exposed = models.filter(m => m.canonicalModelId === canonicalModelId || m.id === canonicalModelId);
    const available = choices.filter(c => c.available);
    const entry = selections.get(canonicalModelId);
    const ref = entry?.ref ?? (available.length === 1 ? available[0].ref : null);
    const valid = ref && available.some(c => sameBinding(c.ref, ref));
    if (!exposed.length && entry?.selected) pending.push({ id: canonicalModelId, canonicalModelId, selectedBinding: valid ? ref : null });
    const removable = exposed.every(m => m.selectedBinding && !Object.values(m.clientCompatibility || {}).some(Boolean));
    if (removable && entry?.selected === false) exposed.forEach(m => removals.add(m.id));
    if (filter === "exposed" && !exposed.length || filter === "unexposed" && exposed.length || filter === "unavailable" && available.length) continue;
    if (search && ![canonicalModelId, ...choices.map(c => c.label)].some(text => text.toLowerCase().includes(search))) continue;
    function select(patch) {
      setSelections(prev => new Map(prev).set(canonicalModelId, { ...prev.get(canonicalModelId), ...patch }));
    }
    rows.push(<div className="form-grid compact" key={canonicalModelId}>
      <label><input type="checkbox" disabled={exposed.length ? !removable : !available.length}
        checked={entry?.selected ?? !!exposed.length} onChange={e => select({ selected: e.target.checked, ref })} /> {canonicalModelId}
        {exposed.length > 0 && ` (${exposed.map(m => m.id).join(", ")})`}</label>
      {exposed.length ? <small>{choices.map(choice => choice.label).join(" · ")}</small> :
        <BindingSelect choices={choices} value={ref} onChange={newRef => select({ ref: newRef })} t={t} />}
    </div>);
  }
  if (!groups.size) return null;
  return <fieldset><legend>{t("channel.exposure")}</legend>
    <Field label={t("channel.filter")}><select value={filter} onChange={e => setFilter(e.target.value)}>
      {["all", "exposed", "unexposed", "unavailable"].map(v => <option key={v} value={v}>{t(v === "all" ? "keys.summary.all" : `channel.${v}`)}</option>)}
    </select></Field>
    {rows}
    <button type="button" disabled={(!pending.length && !removals.size) || pending.some(m => !m.selectedBinding)} onClick={() => {
      updateConfig(next => { next.models = [...next.models.filter(m => !removals.has(m.id)), ...pending]; });
      setSelections(new Map());
    }}>{t("channel.publish")} (+{pending.length} / −{removals.size})</button>
  </fieldset>;
}
