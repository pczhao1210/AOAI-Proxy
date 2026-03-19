import { Section } from "./ui.jsx";

export default function AdvancedTab({ advancedJsonEnabled, advancedJson, updateAdvancedJson, jsonError, dirty, configIssues, configDiffCount, configDiffPreview, t }) {
  return (
    <Section title={t("advanced.title", "Advanced JSON")} desc={t("advanced.desc", "Advanced mode outside the structured forms.")}>
      <div className="status-grid" style={{ marginBottom: "1rem" }}>
        <div className="stat-card">
          <div className="stat-label">{t("config.summary.state", "Editor State")}</div>
          <div className="stat-value">{dirty ? t("config.state.dirty", "Dirty") : t("config.state.clean", "Clean")}</div>
          <div className="stat-note">{t("config.summary.diff", "Changed Fields")} {configDiffCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t("config.summary.validity", "Structure")}</div>
          <div className="stat-value">{configIssues.length ? t("config.validity.invalid", "Needs Review") : t("config.validity.valid", "Valid")}</div>
          <div className="stat-note">{configIssues.length ? t("config.validation.issueCount", "{count} issues detected", { count: configIssues.length }) : t("config.validation.ok", "No structural issues detected.")}</div>
        </div>
      </div>
      <div className="detail-grid" style={{ marginBottom: "1rem" }}>
        <div className="code-block">
          <div className="code-block-head">{t("config.diff.previewTitle", "Diff Preview")}</div>
          <pre>{configDiffPreview}</pre>
        </div>
        <div className="code-block">
          <div className="code-block-head">{t("config.validation.title", "Structure Validation")}</div>
          <pre>{configIssues.length ? configIssues.join("\n") : t("config.validation.ok", "No structural issues detected.")}</pre>
        </div>
      </div>
      {advancedJsonEnabled ? (
        <>
          <textarea className="json-editor" rows={28} value={advancedJson} onChange={(event) => updateAdvancedJson(event.target.value)} />
          {jsonError ? <div className="inline-error">{jsonError}</div> : null}
        </>
      ) : (
        <div className="empty-state">{t("advanced.disabled", "The advanced JSON editor is disabled in the current configuration. Continue editing with the structured React forms above.")}</div>
      )}
    </Section>
  );
}