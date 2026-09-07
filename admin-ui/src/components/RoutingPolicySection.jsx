import { AccordionSection, Field } from "./ui.jsx";
import { getValueByPath, parseList, formatList } from "../utils.js";

function asNumber(value) {
  return Number(value || 0);
}

export default function RoutingPolicySection({ config, updateField, t }) {
  return (
    <AccordionSection id="workspace-routing" title={t("workspace.routing.title", "Routing Domain")} desc={t("workspace.routing.desc", "Manage enablement, allowed fields, and image polling behavior.") } group="workspace-sections">
      <div className="form-grid">
        <Field label={t("field.routeChatAllowedFields", "Chat Allowed Fields")}>
          <input value={formatList(getValueByPath(config, "routing.routeProfiles.chatCompletions.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.chatCompletions.allowedRequestFields", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.routeResponsesAllowedFields", "Responses Allowed Fields")}>
          <input value={formatList(getValueByPath(config, "routing.routeProfiles.responses.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.responses.allowedRequestFields", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.routeMessagesAllowedFields", "Messages Allowed Fields")}>
          <input value={formatList(getValueByPath(config, "routing.routeProfiles.messages.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.messages.allowedRequestFields", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.anthropicBetaAllowlist", "Anthropic Beta Allowlist")}>
          <input value={formatList(getValueByPath(config, "compatibility.anthropic.betaAllowlist"))} onChange={(event) => updateField("compatibility.anthropic.betaAllowlist", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.anthropicUnknownBetaPolicy", "Unknown Anthropic Beta Policy")}>
          <select value={getValueByPath(config, "compatibility.anthropic.unknownBetaPolicy") || "allow-direct-anthropic"} onChange={(event) => updateField("compatibility.anthropic.unknownBetaPolicy", event.target.value)}>
            <option value="allow-direct-anthropic">{t("option.anthropicBetaDirect", "Allow for direct Anthropic upstreams")}</option>
            <option value="allowlist">{t("option.anthropicBetaAllowlist", "Require allowlist for every upstream")}</option>
          </select>
        </Field>
        <Field label={t("field.routeImagesAllowedFields", "Image Allowed Fields")}>
          <input value={formatList(getValueByPath(config, "routing.routeProfiles.imageGenerations.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.allowedRequestFields", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.routeImagesPollInterval", "Image Poll Interval ms")}>
          <input type="number" value={getValueByPath(config, "routing.routeProfiles.imageGenerations.polling.intervalMs") || 0} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.polling.intervalMs", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.routeImagesPollTimeout", "Image Poll Timeout ms")}>
          <input type="number" value={getValueByPath(config, "routing.routeProfiles.imageGenerations.polling.timeoutMs") || 0} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.polling.timeoutMs", asNumber(event.target.value))} />
        </Field>
      </div>
      <div className="checkbox-row">
        <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.chatCompletions.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.chatCompletions.enabled", event.target.checked)} /> {t("field.routeChatEnabled", "Enable chat/completions")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.responses.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.responses.enabled", event.target.checked)} /> {t("field.routeResponsesEnabled", "Enable responses")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.messages.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.messages.enabled", event.target.checked)} /> {t("field.routeMessagesEnabled", "Enable messages")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.protocolShim.rejectLossyRequests") === true} onChange={(event) => updateField("compatibility.protocolShim.rejectLossyRequests", event.target.checked)} /> {t("field.protocolShimRejectLossyRequests", "Reject lossy shim requests")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.protocolShim.rejectLossyResponses") === true} onChange={(event) => updateField("compatibility.protocolShim.rejectLossyResponses", event.target.checked)} /> {t("field.protocolShimRejectLossyResponses", "Reject lossy shim responses")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.forwardSdkMetadataHeaders") !== false} onChange={(event) => updateField("compatibility.anthropic.forwardSdkMetadataHeaders", event.target.checked)} /> {t("field.anthropicForwardSdkMetadata", "Forward Anthropic SDK metadata headers")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.betaAllowlistEnabled") !== false} onChange={(event) => updateField("compatibility.anthropic.betaAllowlistEnabled", event.target.checked)} /> {t("field.anthropicBetaAllowlistEnabled", "Filter Anthropic beta headers")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.normalizeManualThinkingToolChoice") !== false} onChange={(event) => updateField("compatibility.anthropic.normalizeManualThinkingToolChoice", event.target.checked)} /> {t("field.anthropicThinkingToolChoice", "Normalize manual thinking tool choice")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.sanitizeCacheControl") !== false} onChange={(event) => updateField("compatibility.anthropic.sanitizeCacheControl", event.target.checked)} /> {t("field.anthropicCacheControl", "Sanitize Anthropic cache controls")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.validateThinkingByModel") !== false} onChange={(event) => updateField("compatibility.anthropic.validateThinkingByModel", event.target.checked)} /> {t("field.anthropicThinkingByModel", "Validate thinking mode by model")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.imageGenerations.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.enabled", event.target.checked)} /> {t("field.routeImagesEnabled", "Enable image generations")}</label>
      </div>
    </AccordionSection>
  );
}