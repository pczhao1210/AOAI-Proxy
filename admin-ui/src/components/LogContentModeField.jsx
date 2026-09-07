import { Field } from "./ui.jsx";
import { getValueByPath } from "../utils.js";

export default function LogContentModeField({ config, updateField, t }) {
  const contentMode = getValueByPath(config, "observability.logs.messageContentMode") || "summary";
  const updateContentMode = (value) => {
    if (
      value === "full"
      && contentMode !== "full"
      && !window.confirm(t("workspace.logging.fullConfirm", "Full mode records redacted prompts and model output. Secrets and binary payloads remain omitted. Continue?"))
    ) {
      return;
    }
    updateField("observability.logs.messageContentMode", value);
    updateField("observability.logAnalytics.contentMode", value);
  };

  return (
    <Field label={t("field.logMessageContentMode", "Message Content Mode")}>
      <select value={contentMode} onChange={(event) => updateContentMode(event.target.value)}>
        <option value="summary">{t("option.partial", "Partial")}</option>
        <option value="full">{t("option.full", "Full")}</option>
      </select>
    </Field>
  );
}