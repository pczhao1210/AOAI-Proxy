import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import toast from "react-hot-toast";
import DataTable from "./ui/DataTable.jsx";
import Sheet from "./ui/Sheet.jsx";
import KeyEditor, { accessSummary } from "../features/keys/KeyEditor.jsx";
import { useConfigDraft } from "../lib/config-draft.jsx";
import { cloneJson, DEFAULT_KEY_TEMPLATE, ensureUniqueName, formatDateTime } from "../utils.js";

export default function KeysTab({ config, loadedConfig = {}, updateConfig, onCopyApiKey, governanceKeys = [], t }) {
  const [params, setParams] = useSearchParams();
  const { entityDrafts, setEntityDrafts } = useConfigDraft();
  const [error, setError] = useState("");
  const edit = params.get("edit");
  const cacheKey = edit ? `keys:${edit}` : "";
  const original = config.apiKeys?.find(item => item.id === edit);
  const cached = entityDrafts[cacheKey];
  const isNew = cached?.isNew === true;
  const item = cached?.value || original;
  const search = params.get("q") || "";
  const status = params.get("status") || "";
  const tab = params.get("tab") || "basic";
  const query = values => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
    return next;
  });
  useEffect(() => { setError(""); }, [edit]);
  const begin = id => { query({ edit: id, tab: "basic" }); };
  const update = mutator => {
    const value = cloneJson(item);
    mutator(value);
    setEntityDrafts(prev => ({ ...prev, [cacheKey]: { ...cached, base: cached?.base ?? cloneJson(original ?? null), value } }));
  };
  const close = () => {
    if (cached && !window.confirm(t("ui.closeRetain"))) return;
    query({ edit: "", tab: "" });
    if (cached) toast(t("ui.retained"));
  };
  const clear = () => setEntityDrafts(prev => {
    const next = { ...prev }; delete next[cacheKey]; return next;
  });
  const apply = () => {
    if (!item?.id?.trim() || config.apiKeys?.some(key => key.id === item.id && (isNew || key.id !== edit))) return setError(t("ui.identityRequired"));
    if (!isNew && cached && JSON.stringify(cached.base) !== JSON.stringify(original)) return setError(t("ui.entityConflict"));
    updateConfig(next => {
      next.apiKeys ||= [];
      if (isNew) next.apiKeys.push(cloneJson(item));
      else next.apiKeys[next.apiKeys.findIndex(key => key.id === edit)] = cloneJson(item);
    });
    clear();
    query({ edit: "", tab: "" });
    setError("");
    toast(t("ui.appliedToDraft"));
  };
  const setStatus = (rows, value) => updateConfig(next => {
    const ids = new Set(rows.map(row => row.id));
    next.apiKeys.forEach(key => { if (ids.has(key.id)) key.status = value; });
  });
  const rows = (config.apiKeys || []).filter(item => (!status || (item.status || "active") === status)
    && [item.id, item.owner, item.displayName, ...(item.tags || [])].some(value => String(value || "").toLowerCase().includes(search.toLowerCase())));
  const columns = [
    { accessorKey: "id", header: t("field.id"), cell: ({ row }) => <button className="table-link" onClick={() => begin(row.original.id)}>{row.original.displayName || row.original.id}</button> },
    { accessorKey: "owner", header: t("field.owner") },
    { accessorKey: "status", header: t("field.status"), cell: ({ row }) => <button className="ghost row-status" onClick={() => setStatus([row.original], row.original.status === "disabled" ? "active" : "disabled")}>{t(`option.${row.original.status || "active"}`)}</button> },
    { id: "access", header: t("channel.access"), accessorFn: item => accessSummary(item, t) },
    { id: "limits", header: "RPM / TPM", accessorFn: item => `${item.rateLimit?.rpm ?? 0} / ${item.rateLimit?.tpm ?? 0}` },
    { id: "budget", header: t("ui.budgetUsage"), cell: ({ row }) => {
      const runtime = governanceKeys.find(key => key.keyId === row.original.id)?.runtime;
      const state = runtime?.budgetWindow;
      const limit = row.original.budget?.limitAmount;
      if (!state || runtime.known === false || state.spentAmount == null) return t("ui.unknown");
      const partial = state.textUnknownCostRequests > 0 || state.mediaUnknownCostRequests > 0;
      return <span>{partial && state.spentAmount === 0 ? t("ui.unknown") : state.spentAmount} / {limit ?? "—"}
        {partial ? ` · ${t("ui.unknown")}` : limit > 0 ? <progress max={limit} value={state.spentAmount} aria-label={t("ui.budgetUsage")} /> : null}</span>;
    } },
    { id: "lastSeen", header: t("ui.lastSeen"), cell: ({ row }) => {
      const timestamp = governanceKeys.find(key => key.keyId === row.original.id)?.runtime?.lastSeenAt;
      return timestamp ? formatDateTime(timestamp) : t("ui.unknown");
    } },
    { id: "draft", header: t("changes.unsaved"), cell: ({ row }) => JSON.stringify(row.original) !== JSON.stringify(loadedConfig.apiKeys?.find(key => key.id === row.original.id)) ? <span className="status-pill status-dirty">{t("changes.unsaved")}</span> : "—" },
    { id: "actions", header: t("ui.actions"), cell: ({ row }) => <div className="row-actions">
      <Link to={`/usage?key=${encodeURIComponent(row.original.id)}`}>{t("ui.usage")}</Link>
      <Link to={`/logs?key=${encodeURIComponent(row.original.id)}`}>{t("ui.logs")}</Link>
      <button className="ghost danger" onClick={() => {
        if (window.prompt(t("ui.deleteConfirm", "Delete {name}?", { name: row.original.id })) !== row.original.id) return;
        updateConfig(next => { next.apiKeys = next.apiKeys.filter(key => key.id !== row.original.id); });
      }}>{t("entity.delete")}</button>
    </div> }
  ];
  return <section aria-label={t("shell.page.keys")}>
    <div className="table-toolbar">
      <input aria-label={t("ui.search")} placeholder={t("keys.search")} type="search" value={search} onChange={event => query({ q: event.target.value })} />
      <select aria-label={t("field.status")} value={status} onChange={event => query({ status: event.target.value })}><option value="">{t("ui.allStatuses")}</option>{["active", "disabled"].map(value => <option key={value} value={value}>{t(`option.${value}`)}</option>)}</select>
      <button onClick={() => {
        const pending = Object.entries(entityDrafts).find(([key, draft]) => key.startsWith("keys:") && draft.isNew);
        if (pending) { begin(pending[0].slice(5)); return; }
        const value = cloneJson(DEFAULT_KEY_TEMPLATE);
        value.id = ensureUniqueName("key", (config.apiKeys || []).map(item => item.id));
        value.modelAccessMode = "selected"; value.allowedModels = [];
        value.budget = {
          ...value.budget,
          currency: config.access?.budgets?.defaultCurrency || value.budget.currency,
          windowType: config.access?.budgets?.defaultWindowType || value.budget.windowType,
          softLimitRatio: config.access?.budgets?.softLimitRatio ?? value.budget.softLimitRatio,
          hardLimitAction: config.access?.budgets?.hardLimitAction || value.budget.hardLimitAction
        };
        setEntityDrafts(prev => ({ ...prev, [`keys:${value.id}`]: { value, isNew: true } }));
        begin(value.id);
      }}>{t("keys.add")}</button>
    </div>
    <DataTable rows={rows} columns={columns} getRowId={row => row.id} label={t("shell.page.keys")} t={t} onBulkStatus={setStatus} />
    {edit && !item ? <p role="alert">{t("ui.entityMissing")}</p> : null}
    <Sheet open={Boolean(edit && item)} title={item?.displayName || item?.id || t("keys.add")} onClose={close}
      onCancel={() => { if (!cached || window.confirm(t("ui.cancelDraft"))) { clear(); query({ edit: "", tab: "" }); } }}
      onApply={apply} t={t}>
      {error ? <p role="alert">{error}</p> : null}
      {item ? <KeyEditor item={item} original={cached?.base || original} config={config} update={update}
        tab={["basic", "access", "limits", "budget", "notes"].includes(tab) ? tab : "basic"} onTab={tab => query({ tab })} onCopy={onCopyApiKey} t={t} /> : null}
    </Sheet>
  </section>;
}
