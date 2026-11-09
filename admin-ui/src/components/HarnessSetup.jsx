import { useState } from "react";
import { buildHarnessClientConfig } from "../harness-client-config.js";
import { Field } from "./ui.jsx";

const ERRORS = {
  addressRequired: "Enter and confirm the public proxy address.",
  invalidAddress: "Use an HTTP(S) address without credentials, query parameters, fragments or whitespace.",
  adminAddress: "Use the public proxy address, not the administration path.",
  modelRequired: "Select an eligible model in this draft first."
};

export default function HarnessSetup({ client, models, adminPath, t }) {
  const [address, setAddress] = useState("");
  const [modelId, setModelId] = useState("");
  const [feedback, setFeedback] = useState(null);
  const selectedId = models.some(model => model.id === modelId) ? modelId : models[0]?.id || "";
  const result = buildHarnessClientConfig(client.id, address, selectedId, adminPath);

  async function copy(text) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("messages.clipboardUnavailable", "Clipboard access is unavailable in this browser."));
      await navigator.clipboard.writeText(text);
      setFeedback({ ok: true, text: t("harness.setup.copied", "Configuration copied. Replace the credential placeholder locally.") });
    } catch (error) {
      setFeedback({ ok: false, text: error.message || t("harness.setup.copyFailed", "Could not copy the configuration.") });
    }
  }

  return (
    <details className="harness-setup">
      <summary>{t("harness.setup.title", "Client connection guide")}</summary>
      <div className="section-body">
        <p className="muted">{t("harness.setup.hint", "Examples use this draft. Review and save before use. Confirm your public address; no credentials are retrieved and no requests are sent.")}</p>
        <Field label={t("harness.setup.address", "Public proxy address")} hint={t("harness.setup.addressHint", "Enter the proxy root or its /v1 address, never the administration URL.")}>
          <input type="url" placeholder="https://proxy.example.com" value={address} onChange={event => { setAddress(event.target.value); setFeedback(null); }} />
        </Field>
        <Field label={t("harness.setup.model", "Client model")}>
          <select value={selectedId} onChange={event => { setModelId(event.target.value); setFeedback(null); }} disabled={!models.length}>
            {!models.length ? <option value="">{t("harness.setup.modelRequired", ERRORS.modelRequired)}</option> : null}
            {models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
        </Field>
        {result.error ? <p role="status">{t(`harness.setup.${result.error}`, ERRORS[result.error])}</p> : (
          <>
            {result.toml ? (
              <div className="code-block">
                <div className="code-block-head">{t("harness.setup.toml", "Merge into ~/.codex/config.toml (do not overwrite other settings)")}</div>
                <pre>{result.toml}</pre>
                <button type="button" className="ghost" onClick={() => copy(result.toml)}>{t("harness.setup.copyToml", "Copy TOML")}</button>
              </div>
            ) : null}
            <div className="code-block">
              <div className="code-block-head">{t("harness.setup.shell", "Bash / Zsh — replace the placeholder before running")}</div>
              <pre>{result.shell}</pre>
              <button type="button" className="ghost" onClick={() => copy(result.shell)}>{t("harness.setup.copyShell", "Copy shell commands")}</button>
            </div>
          </>
        )}
        {feedback ? <p role={feedback.ok ? "status" : "alert"}>{feedback.text}</p> : null}
        <p className="muted">{t("harness.setup.troubleshoot", "If a model is missing, check saved membership, catalog publication and API key permissions, then refresh discovery or restart the client. This is not a live compatibility check.")}</p>
      </div>
    </details>
  );
}
