import { useState } from "react";
import { Field, ListInput } from "../../components/ui.jsx";
import MultiSelect from "../../components/ui/MultiSelect.jsx";

export function accessSummary(item, t) {
  if (!item.modelAccessMode && !item.allowedModels?.length) return t("ui.legacyAccess");
  if (item.modelAccessMode === "all") return t("ui.allAccess");
  return item.allowedModels?.length ? t("ui.selectedAccess", "{count} selected", { count: item.allowedModels.length }) : t("ui.noAccess");
}

function granted(config, key) {
  if (!key || key.status === "disabled") return [];
  const all = key.modelAccessMode === "all" || (!key.modelAccessMode && !key.allowedModels?.length);
  return (config.models || []).filter(model => model.status !== "disabled" && (all || key.allowedModels?.includes(model.id))).map(model => model.id);
}

export default function KeyEditor({ item, original, config, update, tab, onTab, onCopy, t }) {
  const [visible, setVisible] = useState(false);
  const [copying, setCopying] = useState(false);
  const exposed = (config.models || []).filter(model => model.id && model.status !== "disabled").map(model => model.id);
  const modelLabel = id => {
    const model = config.models.find(item => item.id === id);
    const channel = config.upstreams?.find(up => up.channelId === model?.selectedBinding?.channelId)?.name || model?.upstream;
    return [id, model?.canonicalModelId, channel].filter(Boolean).join(" · ");
  };
  const invalid = (item.allowedModels || []).filter(id => !exposed.includes(id));
  const mode = item.modelAccessMode || (item.allowedModels?.length ? "selected" : "all");
  const before = new Set(granted(config, original));
  const after = new Set(granted(config, item));
  const added = [...after].filter(id => !before.has(id));
  const removed = [...before].filter(id => !after.has(id));
  const set = (field, value) => update(next => { next[field] = value; });
  const nested = (parent, field, value) => update(next => { next[parent] ||= {}; next[parent][field] = value; });
  return <>
    <div role="tablist" className="section-tabs" aria-label={t("ui.edit")}>
      {["basic", "access", "limits", "budget", "notes"].map(id => <button key={id} role="tab" aria-selected={tab === id} className="ghost" onClick={() => onTab(id)}>{t(`ui.${id}`)}</button>)}
    </div>
    <div role="tabpanel">
      {tab === "basic" ? <div className="form-grid compact">
        {["id", "displayName", "owner"].map(field => <Field key={field} label={t(`field.${field}`)}><input value={item[field] || ""} onChange={event => set(field, event.target.value)} /></Field>)}
        <Field label={t("field.status")}><select value={item.status || "active"} onChange={event => set("status", event.target.value)}>{["active", "disabled"].map(value => <option key={value} value={value}>{t(`option.${value}`)}</option>)}</select></Field>
        <Field label={t("field.key")}><input type={visible ? "text" : "password"} autoComplete="new-password" value={item.key || ""} onChange={event => set("key", event.target.value)} /></Field>
        <div className="toolbar">
          <button className="ghost" onClick={() => setVisible(value => !value)}>{t(visible ? "ui.hide" : "ui.reveal")}</button>
          <button className="ghost" disabled={copying} onClick={async () => { setCopying(true); try { await onCopy(item); } finally { setCopying(false); } }}>{t("keys.copy")}</button>
          <button className="ghost" onClick={() => {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            set("key", `sk-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`);
            setVisible(true);
          }}>{t("ui.generate")}</button>
        </div>
      </div> : null}
      {tab === "access" ? <div className="stack-lg">
        <fieldset><legend>{t("channel.access")}</legend>
          {["selected", "all"].map(value => <label key={value} className="inline"><input type="radio" name="access-mode" value={value} checked={mode === value} onChange={() => {
            if (value === "all" && !window.confirm(t("channel.confirmAll"))) return;
            update(next => { next.modelAccessMode = value; if (value === "all") next.allowedModels = []; });
          }} />{t(`channel.${value}`)}</label>)}
        </fieldset>
        {mode === "selected" ? <>
          <MultiSelect label={t("field.allowedModels")} items={exposed} itemLabel={modelLabel} value={(item.allowedModels || []).filter(id => exposed.includes(id))} t={t} onChange={value => update(next => { next.modelAccessMode = "selected"; next.allowedModels = [...invalid, ...value]; })} />
          {invalid.map(id => <p key={id} role="alert">{id} · {t("ui.invalidReference")} <button className="ghost danger" aria-label={`${t("entity.delete")} ${id}`} onClick={() => update(next => {
            next.modelAccessMode = "selected"; next.allowedModels = next.allowedModels.filter(value => value !== id);
          })}>{t("entity.delete")}</button></p>)}
          {!item.allowedModels?.length ? <p>{t("ui.noAccess")}</p> : null}
        </> : null}
        <p>{t(mode === "all" ? "ui.futureAccess" : "ui.fixedAccess")}</p>
        {added.length || removed.length ? <p role="status">{t("channel.accessChanges")} {added.map(id => `+ ${id}`).join(", ")} {removed.map(id => `− ${id}`).join(", ")}</p> : null}
        {config.access?.defaults?.requireApiKey === false ? <p role="note">{t("channel.anonymous")}</p> : null}
      </div> : null}
      {tab === "limits" ? <div className="form-grid compact"><p className="field-hint">{t("ui.zeroLimits")}</p>{[["rpm", "rateLimitRpm"], ["tpm", "rateLimitTpm"], ["concurrency", "concurrency"], ["windowSeconds", "windowSeconds"]].map(([field, label]) => <Field key={field} label={t(`field.${label}`)}>
        <input type="number" min="0" value={item.rateLimit?.[field] ?? (field === "windowSeconds" ? 60 : 0)} onChange={event => nested("rateLimit", field, Number(event.target.value))} />
      </Field>)}</div> : null}
      {tab === "budget" ? <div className="form-grid compact">
        <Field label={t("field.budgetLimit")}><input type="number" min="0" step="0.01" value={item.budget?.limitAmount ?? 0} onChange={event => nested("budget", "limitAmount", Number(event.target.value))} /></Field>
        <Field label={t("field.budgetCurrency")}><input value={item.budget?.currency ?? "USD"} onChange={event => nested("budget", "currency", event.target.value)} /></Field>
        <Field label={t("field.budgetWindow")}><select value={item.budget?.windowType || "monthly"} onChange={event => nested("budget", "windowType", event.target.value)}>{["daily", "weekly", "monthly"].map(value => <option key={value} value={value}>{t(`option.${value}`)}</option>)}</select></Field>
      </div> : null}
      {tab === "notes" ? <>
        <Field label={t("field.tags")}><ListInput value={item.tags} onChange={value => set("tags", value)} /></Field>
        <Field label={t("field.notes")}><textarea rows={6} value={item.notes || ""} onChange={event => set("notes", event.target.value)} /></Field>
      </> : null}
    </div>
  </>;
}
