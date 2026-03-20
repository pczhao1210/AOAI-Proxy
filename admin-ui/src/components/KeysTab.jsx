import { useState } from "react";
import { EntityCard, Field, Section, StatCard } from "./ui.jsx";
import { formatList, parseList } from "../utils.js";

export default function KeysTab({ config, updateConfig, addApiKey, t }) {
  const [search, setSearch] = useState("");
  const items = config.apiKeys || [];
  const searchTerm = search.trim().toLowerCase();
  const filteredItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (
      !searchTerm
      || (item.id || "").toLowerCase().includes(searchTerm)
      || (item.displayName || "").toLowerCase().includes(searchTerm)
      || (item.owner || "").toLowerCase().includes(searchTerm)
    ));
  const activeCount = items.filter((item) => (item.status || "active") === "active").length;
  const disabledCount = items.filter((item) => item.status === "disabled").length;
  const budgetedCount = items.filter((item) => Number(item.budget?.limitAmount || 0) > 0).length;

  return (
    <Section
      id="keys-overview"
      title={t("keys.title", "Key Governance")}
      desc={t("keys.desc", "Maintain key ownership, model permissions, rate limits, budgets, and notes.")}
      actions={
        <div className="toolbar-cluster">
          <input 
            className="search-field"
            type="search" 
            placeholder={t("keys.search", "Search keys...")} 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" onClick={addApiKey}>{t("keys.add", "Add Key")}</button>
        </div>
      }
    >
      <div className="status-grid">
        <StatCard label={t("keys.summary.total", "Total Keys")} value={items.length} note={t("keys.summary.filtered", "Visible {count}", { count: filteredItems.length })} />
        <StatCard label={t("keys.summary.active", "Active Keys")} value={activeCount} note={`${t("keys.summary.disabled", "Disabled")} ${disabledCount}`} />
        <StatCard label={t("keys.summary.budgeted", "Budgeted")} value={budgetedCount} note={t("keys.summary.modelScoped", "Keys with budget or model restrictions") } />
        <StatCard label={t("keys.summary.search", "Current View")} value={searchTerm ? t("keys.summary.filteredShort", "Filtered") : t("keys.summary.all", "All")} note={searchTerm || t("keys.summary.noSearch", "No search filter applied")} />
      </div>

      <div id="keys-list" className="entity-grid">
        {filteredItems.map(({ item, index }) => {
          const allowedModelsCount = Array.isArray(item.allowedModels) ? item.allowedModels.length : 0;
          const statusLabel = t(`option.${item.status || "active"}`, item.status || "active");
          const budgetText = Number(item.budget?.limitAmount || 0) > 0
            ? `${Number(item.budget.limitAmount || 0).toFixed(2)} ${item.budget?.currency || "USD"}`
            : t("keys.summary.noBudget", "No budget");
          return (
            <EntityCard
              id={`key-card-${index}`}
              key={`key-${index}`}
              title={item.displayName || item.id || `key-${index + 1}`}
              subtitle={item.owner || t("status.keySubtitleFallback", "Owner not set")}
              meta={`${t("field.status", "Status")}: ${statusLabel} · ${t("field.allowedModels", "Allowed Models")}: ${allowedModelsCount} · ${t("field.budgetLimit", "Budget Limit")}: ${budgetText}`}
              removeLabel={t("entity.delete", "Delete")}
              collapsible
              defaultOpen={false}
              group="keys-list"
              onRemove={() => updateConfig((next) => {
                next.apiKeys = (next.apiKeys || []).filter((_, keyIndex) => keyIndex !== index);
              })}
            >
              <div className="form-grid compact">
                <Field label={t("field.id", "ID")}><input value={item.id || ""} onChange={(event) => updateConfig((next) => { next.apiKeys[index].id = event.target.value; })} /></Field>
                <Field label={t("field.displayName", "Display Name")}><input value={item.displayName || ""} onChange={(event) => updateConfig((next) => { next.apiKeys[index].displayName = event.target.value; })} /></Field>
                <Field label={t("field.owner", "Owner")}><input value={item.owner || ""} onChange={(event) => updateConfig((next) => { next.apiKeys[index].owner = event.target.value; })} /></Field>
                <Field label={t("field.status", "Status")}><select value={item.status || "active"} onChange={(event) => updateConfig((next) => { next.apiKeys[index].status = event.target.value; })}><option value="active">{t("option.active", "active")}</option><option value="disabled">{t("option.disabled", "disabled")}</option></select></Field>
                <Field label={t("field.key", "Key")}><input value={item.key || ""} onChange={(event) => updateConfig((next) => { next.apiKeys[index].key = event.target.value; })} /></Field>
                <Field label={t("field.allowedModels", "Allowed Models")}><input value={formatList(item.allowedModels)} onChange={(event) => updateConfig((next) => { next.apiKeys[index].allowedModels = parseList(event.target.value); })} /></Field>
                <Field label={t("field.rateLimitRpm", "Rate Limit RPM")}><input type="number" value={item.rateLimit?.rpm || 0} onChange={(event) => updateConfig((next) => { next.apiKeys[index].rateLimit = next.apiKeys[index].rateLimit || {}; next.apiKeys[index].rateLimit.rpm = Number(event.target.value || 0); })} /></Field>
                <Field label={t("field.rateLimitTpm", "Rate Limit TPM")}><input type="number" value={item.rateLimit?.tpm || 0} onChange={(event) => updateConfig((next) => { next.apiKeys[index].rateLimit = next.apiKeys[index].rateLimit || {}; next.apiKeys[index].rateLimit.tpm = Number(event.target.value || 0); })} /></Field>
                <Field label={t("field.concurrency", "Concurrency")}><input type="number" value={item.rateLimit?.concurrency || 0} onChange={(event) => updateConfig((next) => { next.apiKeys[index].rateLimit = next.apiKeys[index].rateLimit || {}; next.apiKeys[index].rateLimit.concurrency = Number(event.target.value || 0); })} /></Field>
                <Field label={t("field.windowSeconds", "Window Seconds")}><input type="number" value={item.rateLimit?.windowSeconds || 60} onChange={(event) => updateConfig((next) => { next.apiKeys[index].rateLimit = next.apiKeys[index].rateLimit || {}; next.apiKeys[index].rateLimit.windowSeconds = Number(event.target.value || 0); })} /></Field>
                <Field label={t("field.budgetLimit", "Budget Limit")}><input type="number" step="0.01" value={item.budget?.limitAmount || 0} onChange={(event) => updateConfig((next) => { next.apiKeys[index].budget = next.apiKeys[index].budget || {}; next.apiKeys[index].budget.limitAmount = Number(event.target.value || 0); })} /></Field>
                <Field label={t("field.budgetWindow", "Budget Window")}><select value={item.budget?.windowType || "monthly"} onChange={(event) => updateConfig((next) => { next.apiKeys[index].budget = next.apiKeys[index].budget || {}; next.apiKeys[index].budget.windowType = event.target.value; })}><option value="daily">{t("option.daily", "daily")}</option><option value="weekly">{t("option.weekly", "weekly")}</option><option value="monthly">{t("option.monthly", "monthly")}</option></select></Field>
              </div>
              <Field label={t("field.tags", "Tags")}><input value={formatList(item.tags)} onChange={(event) => updateConfig((next) => { next.apiKeys[index].tags = parseList(event.target.value); })} /></Field>
              <Field label={t("field.notes", "Notes")}><textarea rows={3} value={item.notes || ""} onChange={(event) => updateConfig((next) => { next.apiKeys[index].notes = event.target.value; })} /></Field>
            </EntityCard>
          );
        })}
      </div>
    </Section>
  );
}