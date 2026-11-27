import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import toast from "react-hot-toast";
import RoutingTab from "../../components/RoutingTab.jsx";
import { ExposurePicker, channelCandidates } from "../../components/ChannelModels.jsx";
import DataTable from "../../components/ui/DataTable.jsx";
import Sheet from "../../components/ui/Sheet.jsx";
import { useConfigDraft } from "../../lib/config-draft.jsx";
import { cloneJson, DEFAULT_UPSTREAM_TEMPLATE, ensureUniqueName, newChannelId } from "../../utils.js";
import { newCopilotChannel } from "../../copilot.js";
import { fetchHarnessEligibility } from "../../api.js";
import { useCopilotEvidence } from "./use-copilot-evidence.js";
import RoutePolicyEditor from "./RoutePolicyEditor.jsx";

export default function RoutingPage(props) {
  const { config, loadedConfig, updateConfig, view, t, pricingLibrary = [] } = props;
  const { entityDrafts, setEntityDrafts } = useConfigDraft();
  const [params, setParams] = useSearchParams();
  const [masked, setMasked] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const channels = view !== "models";
  const type = channels ? "upstreams" : "models";
  const identity = item => channels ? item.channelId || item.name : item.id;
  const edit = params.get("edit");
  const cacheKey = `${type}:${edit}`;
  const cached = entityDrafts[cacheKey];
  const snapshot = cached?.value || config;
  const discovery = useCopilotEvidence(snapshot.upstreams || [], !channels);
  useEffect(() => {
    setPreview(null);
    if (!cached) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await fetchHarnessEligibility(snapshot, { signal: controller.signal });
        if (!cancelled) setPreview({ config: snapshot, value: result.capabilities?.preview });
      } catch (error) {
        if (!cancelled) setError(error.message);
      }
    }, 180);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [snapshot, Boolean(cached)]);
  const selectedIndex = cached?.index ?? (config[type] || []).findIndex(item => identity(item) === edit);
  const item = snapshot[type]?.[selectedIndex];
  const tab = params.get("tab") || "connection";
  const q = params.get("q") || "";
  const status = params.get("status") || "";
  const provider = params.get("provider") || "";
  const group = params.get("group") || "canonical";
  const query = values => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
    return next;
  });
  const update = mutator => {
    const value = cloneJson(snapshot); mutator(value);
    setEntityDrafts(prev => ({ ...prev, [cacheKey]: { ...cached, base: cached?.base || config, value, index: selectedIndex } }));
  };
  const clear = () => setEntityDrafts(prev => {
    const next = { ...prev }; delete next[cacheKey]; return next;
  });
  const apply = () => {
    if (Object.keys(cached?.mappingDrafts || {}).length) return setError(t("channel.pendingJson"));
    if (cached && JSON.stringify(cached.base) !== JSON.stringify(config)) return setError(t("ui.entityConflict"));
    const id = channels ? item.name : item.id;
    if (!id?.trim() || snapshot[type].some((other, index) => index !== selectedIndex && (channels ? other.name : other.id) === id)) return setError(t("ui.identityRequired"));
    if (cached) updateConfig(next => {
      for (const key of new Set([...Object.keys(cached.base), ...Object.keys(snapshot)])) {
        if (JSON.stringify(cached.base[key]) !== JSON.stringify(snapshot[key])) {
          if (Object.hasOwn(snapshot, key)) next[key] = cloneJson(snapshot[key]);
          else delete next[key];
        }
      }
    });
    clear();
    query({ edit: identity(item) });
    setError("");
  };
  const open = item => { setError(""); query({ edit: identity(item), tab: channels ? "connection" : "basic" }); };
  const rows = (config[type] || []).filter(item => (!status || (item.status || "active") === status)
    && (!channels || !provider || (item.provider || "azure-openai") === provider)
    && [identity(item), item.displayName, item.name, item.provider, item.canonicalModelId].some(value => String(value || "").toLowerCase().includes(q.toLowerCase())));
  const references = row => channels
    ? (config.models || []).filter(model => model.upstream === row.name || model.selectedBinding?.channelId === row.channelId).map(model => model.id)
    : [
      ...(config.apiKeys || []).filter(key => key.allowedModels?.includes(row.id)).map(key => `Key: ${key.id}`),
      ...Object.entries(row.clientCompatibility || {}).filter(([, value]) => value).map(([client]) => client),
      ...(config.media?.generation?.defaultModel === row.id ? ["media.generation.defaultModel"] : [])
    ];
  const setStatus = (rows, status) => updateConfig(next => {
    const ids = new Set(rows.map(identity));
    next[type].forEach(item => { if (ids.has(identity(item))) item.status = status; });
  });
  const updateExposure = mutate => {
    const next = cloneJson(config);
    mutate(next);
    const removed = (config.models || []).filter(model => !next.models.some(candidate => candidate.id === model.id));
    const affected = removed.flatMap(model => references(model).map(reference => `${model.id}: ${reference}`));
    if (affected.length) { setError(`${t("ui.references")}: ${affected.join(", ")}`); return; }
    updateConfig(draft => { draft.models = next.models; });
  };
  const columns = [
    { id: "name", header: t(channels ? "field.name" : "routing.field.proxyModelId"), accessorFn: item => item.name || item.id, cell: ({ row }) => <button className="table-link" onClick={() => open(row.original)}>{row.original.name || row.original.id}</button> },
    { id: "type", header: t(channels ? "field.provider" : "channel.canonical"), accessorFn: item => channels ? item.provider || "azure-openai"
      : item.canonicalModelId || props.capabilityView?.models?.find(model => model.modelId === item.id)?.canonicalModelId || t("ui.unknown") },
    { accessorKey: "status", header: t("field.status"), cell: ({ row }) => <button className="ghost row-status" onClick={() => setStatus([row.original], row.original.status === "disabled" ? "active" : "disabled")}>{t(`option.${row.original.status || "active"}`)}</button> },
    { id: "binding", header: t(channels ? "field.baseUrl" : "channel.binding"), accessorFn: item => channels ? masked ? "••••" : item.baseUrl
      : item.selectedBinding ? `${config.upstreams?.find(up => up.channelId === item.selectedBinding.channelId)?.name || item.selectedBinding.channelId} / ${item.selectedBinding.sourceModelId}` : `${item.upstream || "—"} / ${item.targetModel || "—"}` },
    { id: "metadata", header: t(channels ? "channel.mapping" : "field.defaultRoute"), accessorFn: item => channels
      ? `${item.modelMappings?.filter(mapping => mapping.enabled).length || 0} / ${item.modelMappings?.length || 0}` : item.routes?.["*"] || "—" },
    ...(channels ? [{ id: "auth", header: t("field.upstreamAuthMode"), accessorFn: item => item.provider === "github-copilot" ? "GitHub Copilot" : item.auth?.mode || t("option.inheritAuth") }] : []),
    ...(!channels ? [
      { id: "clients", header: t("shell.page.clients"), accessorFn: item => Object.entries(item.clientCompatibility || {}).filter(([, enabled]) => enabled).map(([client]) => client).join(", ") || "—" },
      { id: "catalog", header: "Catalog", accessorFn: item => {
        const descriptor = props.capabilityView?.models?.find(model => model.modelId === item.id);
        return descriptor ? t(descriptor.canonicalModelId ? "ui.catalogMatched" : "ui.catalogMissing") : t("ui.unknown");
      } }
    ] : []),
    { id: "draft", header: t("changes.unsaved"), cell: ({ row }) => JSON.stringify(row.original) !== JSON.stringify(loadedConfig?.[type]?.find(item => identity(item) === identity(row.original))) ? <span className="status-pill status-dirty">{t("changes.unsaved")}</span> : "—" },
    { id: "actions", header: t("ui.actions"), cell: ({ row }) => <div className="row-actions">
      <button className="ghost" onClick={() => open(row.original)}>{t("ui.edit")}</button>
      <Link to="/diagnostics">{t("shell.page.diagnostics")}</Link>
      <button className="ghost danger" onClick={() => {
        const refs = references(row.original);
        if (refs.length) { setError(`${t("ui.references")}: ${refs.join(", ")}`); return; }
        const name = channels ? row.original.name : row.original.id;
        if (window.prompt(t("ui.deleteConfirm", "Delete {name}?", { name })) !== name) return;
        updateConfig(next => { next[type] = next[type].filter(item => identity(item) !== identity(row.original)); });
      }}>{t("entity.delete")}</button>
    </div> }
  ];
  const addChannel = provider => {
    const value = cloneJson(config);
    const channelId = newChannelId();
    const name = ensureUniqueName("channel", (config.upstreams || []).map(item => item.name));
    value.upstreams ||= [];
    const index = value.upstreams.length;
    const item = provider === "github-copilot" ? newCopilotChannel(channelId, name) : { ...cloneJson(DEFAULT_UPSTREAM_TEMPLATE), channelId, name, modelMappings: [] };
    value.upstreams.push(item);
    setEntityDrafts(prev => ({ ...prev, [`upstreams:${channelId}`]: { base: config, value, index } }));
    open(item);
  };
  return <section>
    <div className="table-toolbar">
      <input type="search" aria-label={t("ui.search")} placeholder={t("ui.search")} value={q} onChange={event => query({ q: event.target.value })} />
      <select aria-label={t("field.status")} value={status} onChange={event => query({ status: event.target.value })}><option value="">{t("ui.allStatuses")}</option>{["active", "disabled"].map(value => <option key={value} value={value}>{t(`option.${value}`)}</option>)}</select>
      {channels ? <>
        <select aria-label={t("field.provider")} value={provider} onChange={event => query({ provider: event.target.value })}>
          <option value="">{t("ui.allProviders")}</option>
          {[...new Set((config.upstreams || []).map(item => item.provider || "azure-openai"))].sort().map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <label className="inline"><input type="checkbox" checked={masked} onChange={event => setMasked(event.target.checked)} />{t("ui.mask")}</label>
        <button onClick={() => addChannel()}>{t("routing.addUpstream")}</button>
        <button className="ghost" onClick={() => addChannel("github-copilot")}>{t("copilot.add")}</button>
      </> : <>
        <select aria-label={t("ui.groupBy")} value={group} onChange={event => query({ group: event.target.value })}>
          <option value="canonical">{t("channel.canonical")}</option><option value="public">{t("routing.field.proxyModelId")}</option>
        </select>
        <button onClick={props.addModel}>{t("routing.addModel")}</button><button className="ghost" onClick={props.addBlankModel}>{t("routing.addBlankModel")}</button>
      </>}
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {discovery.error ? <p role="alert">{discovery.error}</p> : null}
    {!channels ? <details className="exposure-picker"><summary>{t("channel.exposure")}</summary>
      <ExposurePicker groups={channelCandidates(config.upstreams || [], pricingLibrary, discovery.evidence)} models={config.models || []} search={q} updateConfig={updateExposure} t={t} />
    </details> : null}
    <DataTable rows={rows} columns={columns} getRowId={identity} label={t(!channels && group === "canonical" ? "ui.groupedModels" : `shell.page.${view}`)} t={t} onBulkStatus={setStatus}
      groupBy={!channels && group === "canonical" ? "type" : undefined} />
    {edit && !item ? <p role="alert">{t("ui.entityMissing")}</p> : null}
    <Sheet open={Boolean(edit && item)} title={item?.name || item?.id || ""} t={t} onApply={apply}
      onClose={() => { if (cached && !window.confirm(t("ui.closeRetain"))) return; query({ edit: "", tab: "" }); if (cached) toast(t("ui.retained")); }}
      onCancel={() => { if (!cached || window.confirm(t("ui.cancelDraft"))) { clear(); query({ edit: "", tab: "" }); } }}>
      {error ? <p role="alert">{error}</p> : null}
      <p className="wide-screen-note">{t("ui.wideScreen")}</p>
      {!channels ? <p><Link to="/clients">{t("shell.page.clients")}</Link>
        {(config.apiKeys || []).filter(key => key.allowedModels?.includes(item?.id)).map(key => <Link className="reference-link" key={key.id} to={`/keys?edit=${encodeURIComponent(key.id)}`}>Key: {key.id}</Link>)}
      </p> : null}
      <div className="section-tabs" role="tablist" aria-label={t("ui.edit")}>{(channels ? ["connection", "mappings", "routes", "policy", "advanced"] : ["basic", "routes", "policy", "advanced"]).map(value => <button key={value} role="tab" aria-selected={tab === value} className="ghost" onClick={() => query({ tab: value })}>{t(`ui.${value}`)}</button>)}</div>
      {tab === "advanced" ? <pre>{JSON.stringify(item, null, 2)}</pre> : null}
      {item && ["routes", "policy"].includes(tab) ? <RoutePolicyEditor item={item} channels={channels} tab={tab} t={t}
        update={mutate => update(next => mutate(next[type][selectedIndex]))} /> : null}
      <div hidden={!["connection", "mappings", "basic"].includes(tab)}>
      {item ? <RoutingTab {...props} config={snapshot} updateConfig={update}
        evidence={channels ? undefined : discovery.evidence}
        editor={{ type, index: selectedIndex, section: tab }} capabilityView={cached ? preview?.config === snapshot ? preview.value : null : props.capabilityView}
        capabilityPreview={Boolean(cached) || props.capabilityPreview}
        mappingDrafts={cached?.mappingDrafts || {}} setMappingDrafts={updater => setEntityDrafts(prev => {
          const current = prev[cacheKey] || { base: config, value: cloneJson(config), index: selectedIndex };
          const mappingDrafts = typeof updater === "function" ? updater(current.mappingDrafts || {}) : updater;
          return { ...prev, [cacheKey]: { ...current, mappingDrafts } };
        })} /> : null}
      </div>
    </Sheet>
  </section>;
}
