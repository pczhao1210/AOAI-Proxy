import { useEffect, useState } from "react";
import { formatList, parseList } from "../utils.js";
import { Field } from "./ui.jsx";

const FIELDS = ["contextWindow", "supportedReasoningEfforts", "defaultReasoningEffort", "priority", "description", "baseInstructions"];

export default function CodexModelSettings({ model, metadata, activeMetadata, unique, updateConfig, t }) {
  const value = model.codex || {};
  const formattedEfforts = formatList(value.supportedReasoningEfforts);
  const [efforts, setEfforts] = useState(formattedEfforts);
  useEffect(() => setEfforts(formattedEfforts), [formattedEfforts]);

  function updateFields(changes) {
    updateConfig(next => {
      const matches = (next.models || []).filter(item => item.id === model.id);
      if (!unique || matches.length !== 1) throw new Error("Codex settings require a unique model ID");
      const target = matches[0];
      target.codex = { ...(target.codex || {}) };
      for (const [field, input] of Object.entries(changes)) {
        if (input === undefined) delete target.codex[field];
        else target.codex[field] = input;
      }
    });
  }

  function source(path) {
    const name = path?.startsWith("models[]") ? t("harness.codex.sourceConfig", "Configuration override")
      : path?.startsWith("catalog.") ? t("harness.codex.sourceCatalog", "Model Catalog")
        : path === "filtered-catalog-order" ? t("harness.codex.sourceOrder", "Filtered catalog order")
          : t("harness.codex.sourceFallback", "Existing fallback");
    return `${name}${path && path !== "fallback" ? ` · ${path}` : ""}`;
  }

  const preview = metadata?.info;
  const invalidContext = value.contextWindow != null && (!Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0);
  return (
    <details className="harness-codex-settings">
      <summary>{t("harness.codex.settings", "Codex metadata and overrides")}</summary>
      <div className="section-body">
        <p className="muted">{t("harness.codex.previewHint", "Draft preview before API key filtering. Default priority follows the filtered catalog order and can differ by client permissions.")}</p>
        {preview ? (
          <dl className="harness-metadata">
            {[
              ["context_window", t("harness.codex.context", "Context window"), preview.context_window],
              ["supported_reasoning_levels", t("harness.codex.efforts", "Supported reasoning efforts"), preview.supported_reasoning_levels.map(level => level.effort).join(", ") || "-"],
              ["default_reasoning_level", t("harness.codex.defaultEffort", "Default reasoning effort"), preview.default_reasoning_level],
              ["priority", t("harness.codex.priority", "Priority"), preview.priority],
              ["base_instructions", t("harness.codex.instructions", "Base instructions"), preview.base_instructions]
            ].map(([key, label, resolved]) => (
              <div key={key}><dt>{label}</dt><dd>{resolved}<small>{source(metadata.sources?.[key])}</small></dd></div>
            ))}
          </dl>
        ) : <p role="status">{t("harness.unknown", "Eligibility not confirmed")}</p>}
        {preview ? <details><summary>{t("harness.codex.rawPreview", "Draft catalog JSON")}</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details> : null}
        {activeMetadata ? <details><summary>{t("harness.codex.activePreview", "Active catalog JSON")}</summary><pre>{JSON.stringify(activeMetadata.info, null, 2)}</pre></details> : null}
        <p className="muted">{t("harness.codex.overrideHint", "Blank fields inherit existing behavior. Overrides affect discovery metadata, not provider capabilities or request validation.")}</p>
        <fieldset disabled={!unique} className="harness-overrides">
          <Field label={t("harness.codex.contextOverride", "Context window override")}>
            <input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" value={value.contextWindow ?? ""} aria-invalid={invalidContext}
              onChange={event => updateFields({ contextWindow: event.target.value === "" ? undefined : Number(event.target.value) })} />
          </Field>
          {invalidContext ? <p role="alert">{t("harness.codex.invalidContext", "Context window must be a positive safe integer. Correct or clear this override before saving.")}</p> : null}
          <Field label={t("harness.codex.effortsOverride", "Supported efforts override")} hint={t("harness.codex.effortsHint", "Comma-separated; applied when leaving the field. Undocumented values are not automatically rejected.")}>
            <input value={efforts} onChange={event => setEfforts(event.target.value)} onBlur={() => {
              if (efforts !== formattedEfforts) updateFields({ supportedReasoningEfforts: efforts.trim() ? parseList(efforts) : undefined });
            }} />
          </Field>
          <Field label={t("harness.codex.defaultOverride", "Default effort override")} hint={t("harness.codex.defaultHint", "If absent from the effective supported list, existing default fallback rules apply; the preview shows the result.")}>
            <input value={value.defaultReasoningEffort ?? ""} onChange={event => updateFields({ defaultReasoningEffort: event.target.value || undefined })} />
          </Field>
          <Field label={t("harness.codex.priorityOverride", "Priority override")}>
            <input type="number" step="1" value={value.priority ?? ""} onChange={event => updateFields({ priority: event.target.value === "" ? undefined : Number(event.target.value) })} />
          </Field>
          <Field label={t("harness.codex.descriptionOverride", "Description override")}>
            <input value={value.description ?? ""} onChange={event => updateFields({ description: event.target.value || undefined })} />
          </Field>
          <Field label={t("harness.codex.instructionsOverride", "Base instructions override")}>
            <textarea rows="4" value={value.baseInstructions ?? ""} onChange={event => updateFields({ baseInstructions: event.target.value || undefined })} />
          </Field>
          <button type="button" className="ghost" onClick={() => {
            setEfforts("");
            updateFields(Object.fromEntries(FIELDS.map(field => [field, undefined])));
          }}>{t("harness.codex.clear", "Clear displayed overrides")}</button>
        </fieldset>
      </div>
    </details>
  );
}
