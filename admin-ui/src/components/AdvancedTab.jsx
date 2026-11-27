import { useState } from "react";
import { Modal, Section } from "./ui.jsx";
import { buildConfigDiffPreview, computeConfigDiff, summarizeConfigDiff } from "../utils.js";

export default function AdvancedTab({ advancedJsonEnabled, advancedJson, config, updateAdvancedJson, onSaveJson, onResetJson, saving, pending, jsonError, dirty, configDiffCount, configDiffPreview, t }) {
  const [review, setReview] = useState(false);
  const diff = !jsonError && config ? computeConfigDiff(config, JSON.parse(advancedJson)) : null;
  const replacementDiff = diff ? buildConfigDiffPreview(diff, t, Infinity) : "";
  return (
    <Section id="advanced-json" title={t("advanced.title", "Advanced JSON")} desc={t("advanced.desc", "Advanced mode outside the structured forms.")}>
      <div className="status-grid" style={{ marginBottom: "1rem" }}>
        <div className="stat-card">
          <div className="stat-label">{t("config.summary.state", "Editor State")}</div>
          <div className="stat-value">{dirty ? t("config.state.dirty", "Dirty") : t("config.state.clean", "Clean")}</div>
          <div className="stat-note">{t("config.summary.diff", "Changed Fields")} {pending ? diff ? summarizeConfigDiff(diff) : "—" : configDiffCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">JSON</div>
          <div className="stat-value">{jsonError ? t("config.validity.invalid", "Needs Review") : t("advanced.parsed")}</div>
          <div className="stat-note">{t("advanced.serverValidation")}</div>
        </div>
      </div>
      <div className="detail-grid" style={{ marginBottom: "1rem" }}>
        <div className="code-block">
          <div className="code-block-head">{t("config.diff.previewTitle", "Diff Preview")}</div>
          <pre>{pending ? replacementDiff : configDiffPreview}</pre>
        </div>
        <div className="code-block">
          <div className="code-block-head">{t("config.validation.title", "Structure Validation")}</div>
          <pre>{jsonError || t("advanced.serverValidation")}</pre>
        </div>
      </div>
      {advancedJsonEnabled ? (
        <>
          <p>{t("advanced.replaceHint")}</p>
          <textarea aria-label={t("advanced.title")} className="json-editor" spellCheck={false} rows={28} value={advancedJson} onChange={(event) => updateAdvancedJson(event.target.value)} />
          {jsonError ? <div role="alert" className="inline-error">{jsonError}</div> : null}
          <div className="table-toolbar">
            <button disabled={!pending || !!jsonError || saving} onClick={() => setReview(true)}>{t("advanced.reviewReplace")}</button>
            <button className="ghost" disabled={!pending || saving} onClick={onResetJson}>{t("advanced.reset")}</button>
          </div>
          <Modal isOpen={review} title={t("advanced.reviewReplace")} onClose={() => setReview(false)}
            onConfirm={() => { setReview(false); void onSaveJson(); }} disabled={saving || !!jsonError}
            confirmLabel={t("advanced.confirmReplace")} cancelLabel={t("common.cancel")} closeLabel={t("common.close")}>
            <p>{t("advanced.replaceHint")}</p><pre>{replacementDiff}</pre>
          </Modal>
        </>
      ) : (
        <div className="empty-state">{t("advanced.disabled", "The advanced JSON editor is disabled in the current configuration. Continue editing with the structured React forms above.")}</div>
      )}
    </Section>
  );
}