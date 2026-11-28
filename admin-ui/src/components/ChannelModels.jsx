import { useId, useState } from "react";
import { bindingsBrokenBy, deploymentFields, hasHarnessRouteConfirmation, sameBinding, unresolvedBindings, validateMappingRows } from "../../../src/channel-bindings.js";
import { Field } from "./ui.jsx";
import { newChannelId, parseList } from "../utils.js";
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

export function bindingInUseMessage(models, t) {
  return t("channel.bindingInUse", undefined, { models: models.map(model => model.id).join(", ") });
}

function ChannelModelList({ up, models, definitions, updateRows, blocked, t }) {
  const optionsId = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const rows = up.modelMappings;
  const catalogIds = new Set(definitions.map(card => card.id));
  const activeIds = [...new Set(rows.filter(row => row.enabled).map(row => row.canonicalModelId))];
  const change = mutate => {
    const next = structuredClone(rows);
    try {
      mutate(next);
      validateMappingRows(next, "modelMappings", catalogIds);
      const broken = bindingsBrokenBy(models, up.channelId, rows, next);
      if (broken.length) throw new Error(bindingInUseMessage(broken, t));
      updateRows(next);
      setError("");
      return true;
    } catch (failure) {
      setError(failure.message);
      return false;
    }
  };
  return <section className="channel-model-list" aria-label={t("channel.modelIds")}>
    <h3>{t("channel.modelIds")}</h3>
    <p className="muted">{t("channel.modelIdsHint")}</p>
    <div className="multi-chips">{activeIds.length ? activeIds.map(id => <span className="multi-chip" key={id}>
      {id}<button type="button" aria-label={`${t("entity.delete")} ${id}`} disabled={blocked}
        onClick={() => change(next => {
          next.forEach(row => { if (row.canonicalModelId === id) row.enabled = false; });
        })}>×</button>
    </span>) : <span className="muted">{t("channel.noModelIds")}</span>}</div>
    <div className="table-toolbar">
      <input list={optionsId} aria-label={t("channel.modelIds")} value={text} disabled={blocked}
        placeholder={t("channel.modelIdsPlaceholder")} onChange={event => setText(event.target.value)} />
      <datalist id={optionsId}>{definitions.map(card => <option key={card.id} value={card.id} />)}</datalist>
      <button type="button" disabled={blocked || !parseList(text).length} onClick={() => {
        if (change(next => {
          const ids = [...new Set(parseList(text))];
          const unknown = ids.filter(id => !catalogIds.has(id));
          if (unknown.length) throw new Error(`${t("channel.unknownModelIds")}: ${unknown.join(", ")}`);
          for (const id of ids) {
            const matches = next.filter(row => row.canonicalModelId === id);
            if (matches.length) matches.forEach(row => { row.enabled = true; });
            else next.push({ sourceModelId: id, canonicalModelId: id, enabled: true });
          }
        })) setText("");
      }}>{t("channel.addModels")}</button>
      <button type="button" className="ghost" disabled={blocked || !rows.some(row => !row.enabled)} onClick={() => change(next => {
        next.forEach(row => { row.enabled = true; });
      })}>{t("channel.addMappedModels")}</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

export function MappingEditor({ up, saved, index, config, capabilityView, definitions, updateConfig, drafts, setDrafts, t }) {
  const [migrationError, setMigrationError] = useState("");
  const [rowError, setRowError] = useState("");
  const [migrationId] = useState(newChannelId);
  const optionsId = useId();
  const id = up.channelId;
  const draft = Object.hasOwn(drafts, id) ? drafts[id] : null;
  const rows = up.modelMappings || [];
  const models = config.models || [];
  const tableEditable = Array.isArray(rows) && rows.every(row => row && typeof row === "object" && !Array.isArray(row));
  const ids = new Set(definitions.map(card => card.id));
  // Published bindings must change through the model's binding selector, which also resets Harness confirmation.
  const writeRows = change => {
    const next = structuredClone(rows);
    change(next);
    const broken = bindingsBrokenBy(models, id, rows, next);
    setRowError(broken.length ? bindingInUseMessage(broken, t) : "");
    if (!broken.length) updateConfig(draftConfig => { draftConfig.upstreams[index].modelMappings = next; });
  };
  const clearDraft = () => setDrafts(previous => {
    const next = { ...previous };
    delete next[id];
    return next;
  });
  let migrated;
  let migrationIssue = "";
  if (!id && (capabilityView || !config.models?.some(model => model.upstream === up.name))) {
    try {
      const candidate = structuredClone(config);
      migrateChannel(candidate, index, migrationId, capabilityView);
      validateMappingRows(candidate.upstreams[index].modelMappings, "modelMappings", ids);
      migrated = candidate;
    } catch (error) {
      migrationIssue = error.message;
    }
    if (migrated) return <>
      <p className="muted">{t("channel.legacyEditHint")}</p>
      <MappingEditor up={migrated.upstreams[index]} index={index} config={migrated} capabilityView={capabilityView}
        definitions={definitions} drafts={drafts} setDrafts={setDrafts} t={t}
        updateConfig={mutate => {
          const next = structuredClone(migrated);
          mutate(next);
          updateConfig(draft => { draft.models = next.models; draft.upstreams[index] = next.upstreams[index]; });
        }} />
    </>;
  }
  if (!id) return <div className="mapping-migration">
    <p>{t("ui.legacyMappingHint")}</p>
    {migrationIssue ? <p role="alert">{t("channel.migrateFailed")}: {migrationIssue}</p> : null}
    <div className="table-scroll"><table className="mapping-table">
      <thead><tr><th>{t("routing.field.proxyModelId")}</th><th>{t("channel.source")}</th><th>{t("channel.canonical")}</th></tr></thead>
      <tbody>{(config.models || []).filter(model => model.upstream === up.name).map(model => <tr key={model.id}>
        <td>{model.id}</td><td><code>{model.targetModel || model.id}</code></td>
        <td>{capabilityView?.models?.find(entry => entry.modelId === model.id)?.canonicalModelId || t("ui.unknown")}</td>
      </tr>)}</tbody>
    </table></div>
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
    const broken = draft ? bindingsBrokenBy(models, id, rows, parsed) : [];
    if (broken.length) issue = bindingInUseMessage(broken, t);
    else if (draft && draft.base !== JSON.stringify(rows)) issue = t("channel.stale");
  } catch (error) { issue = error.message; }
  const unresolved = unresolvedBindings(models, id, rows);
  return <div>
    {tableEditable ? <ChannelModelList up={up} models={config.models || []} definitions={definitions} blocked={Boolean(draft)}
      updateRows={rows => updateConfig(next => { next.upstreams[index].modelMappings = rows; })} t={t} /> : null}
    <fieldset className="mapping-editor"><legend>{t("channel.mappings")}</legend>
    <p>{t("channel.mappingDirection")} <code>{id}</code></p>
    {unresolved.length ? <p role="alert">{t("channel.bindingUnresolved", undefined, { models: unresolved.map(model => model.id).join(", ") })}</p> : null}
    <datalist id={optionsId}>{definitions.map(card => <option key={card.id} value={card.id} />)}</datalist>
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
      {tableEditable && rows.length > 0 ? <div className="table-scroll"><table className="mapping-table">
        <thead><tr><th>{t("channel.source")}</th><th>{t("channel.canonical")}</th><th>{t("channel.enabled")}</th><th>{t("ui.actions")}</th></tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>
        <td><input list={optionsId} aria-label={`${t("channel.source")} ${i + 1}`} value={row.sourceModelId} onChange={e => {
          const value = e.target.value;
          writeRows(list => { list[i].sourceModelId = value; });
        }} /></td>
        <td><input list={optionsId} aria-label={`${t("channel.canonical")} ${i + 1}`} value={row.canonicalModelId} onChange={e => {
          const value = e.target.value;
          writeRows(list => { list[i].canonicalModelId = value; });
        }} /></td>
        <td><input aria-label={`${t("channel.enabled")} ${i + 1}`} type="checkbox" checked={row.enabled} onChange={e => {
          const checked = e.target.checked;
          writeRows(list => { list[i].enabled = checked; });
        }} /></td>
        <td><button type="button" className="ghost danger" onClick={() => writeRows(list => list.splice(i, 1))}>{t("entity.delete", "Delete")}</button></td>
      </tr>)}</tbody></table></div> : tableEditable ? <p className="empty-state">{t("ui.noMappings")}</p> : null}
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
    {rowError && <p role="alert">{rowError}</p>}
    {issue && <p role="alert">{issue}</p>}
  </fieldset></div>;
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
  const missing = value && !choices.some(choice => key(choice.ref) === key(value));
  return <Field label={t("channel.binding")}><select value={value ? key(value) : ""} onChange={e => {
    const choice = choices.find(c => key(c.ref) === e.target.value);
    if (choice?.available) onChange(choice.ref);
  }}><option value="">—</option>
    {missing ? <option value={key(value)} disabled>{`${value.channelId} → ${value.sourceModelId} (${t("channel.unavailable")})`}</option> : null}
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
