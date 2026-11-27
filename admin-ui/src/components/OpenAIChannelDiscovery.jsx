import { useLayoutEffect, useRef, useState } from "react";
import { discoverOpenAIChannel } from "../api.js";
import { Field } from "./ui.jsx";

export function canDiscoverOpenAIChannel(up, saved) {
  if (!up?.channelId || !saved || up.channelId !== saved.channelId || up.status === "disabled" || up.provider !== "openai"
    || !["https://api.openai.com", "https://api.openai.com/", "https://api.openai.com/v1", "https://api.openai.com/v1/"].includes(up.baseUrl)
    || up.auth?.mode !== "apiKey") return false;
  const { modelMappings: _draftRows, ...draft } = up;
  const { modelMappings: _savedRows, ...persisted } = saved;
  return JSON.stringify(draft) === JSON.stringify(persisted);
}

export default function OpenAIChannelDiscovery({ up, saved, definitions, updateConfig, t }) {
  const [discovery, setDiscovery] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canonical, setCanonical] = useState(new Map());
  const [selected, setSelected] = useState(new Set());
  const request = useRef(null);
  const available = canDiscoverOpenAIChannel(up, saved);
  const existing = new Set((up.modelMappings || []).map(row => row?.sourceModelId));
  const catalog = new Set(definitions.map(card => card.id));
  const target = id => canonical.get(id) ?? (catalog.has(id) ? id : "");

  useLayoutEffect(() => {
    setDiscovery(null);
    setBusy(false);
    setFailed(false);
    setCanonical(new Map());
    setSelected(new Set());
    return () => { request.current?.abort(); };
  }, [up, saved]);

  async function discover() {
    if (!available) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailed(false);
    setDiscovery(null);
    setCanonical(new Map());
    setSelected(new Set());
    try {
      const result = await discoverOpenAIChannel(up.channelId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.channelId !== up.channelId || !Array.isArray(result.models)) throw new Error();
      const ids = result.models.map(model => model?.id);
      if (ids.some(id => typeof id !== "string" || !id || id !== id.trim() || id.includes("*")) || new Set(ids).size !== ids.length) throw new Error();
      setDiscovery({ ids, updatedAt: result.updatedAt });
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (!available) return null;
  const canAdd = selected.size > 0 && [...selected].every(id => discovery?.ids.includes(id) && catalog.has(target(id)) && !existing.has(id));
  return <div>
    <button type="button" className="ghost" disabled={busy} onClick={() => void discover()}>{t("channel.fetchIds")}</button>
    {busy && <p role="status">{t("channel.fetchingIds")}</p>}
    {failed && <p role="alert">{t("channel.fetchFailed")}</p>}
    {discovery && <fieldset><legend>{t("channel.availableIds")}</legend>
      <p>{t("channel.importHint")} · <time>{discovery.updatedAt}</time> · {discovery.ids.length}</p>
      {discovery.ids.map(id => <div key={id} className="form-grid compact">
        <label><input type="checkbox" checked={selected.has(id)} disabled={existing.has(id) || !catalog.has(target(id))}
          onChange={event => {
            const checked = event.target.checked;
            setSelected(prev => { const next = new Set(prev); if (checked) next.add(id); else next.delete(id); return next; });
          }} /> <code>{id}</code></label>
        <Field label={`${t("channel.canonical")} · ${id}`}><select value={target(id)} disabled={existing.has(id)} onChange={event => {
          const value = event.target.value;
          setCanonical(prev => new Map(prev).set(id, value));
          if (!catalog.has(value)) setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
        }}><option value="">—</option>{definitions.map(card => <option key={card.id}>{card.id}</option>)}</select></Field>
      </div>)}
      <button type="button" disabled={!canAdd} onClick={() => {
        if (!canAdd) return;
        updateConfig(next => {
          const channel = next.upstreams.find(item => item.channelId === up.channelId);
          if (!canDiscoverOpenAIChannel(channel, saved) || !Array.isArray(channel.modelMappings)) return;
          const used = new Set(channel.modelMappings.map(row => row.sourceModelId));
          for (const id of selected) if (!used.has(id)) channel.modelMappings.push({
            sourceModelId: id, canonicalModelId: target(id), enabled: false
          });
        });
      }}>{t("channel.importIds")} ({selected.size})</button>
    </fieldset>}
  </div>;
}
