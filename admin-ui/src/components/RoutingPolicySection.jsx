import { AccordionSection, Field, ListInput, SettingLabel } from "./ui.jsx";
import { getValueByPath, formatList } from "../utils.js";

function asNumber(value) {
  return Number(value || 0);
}

export default function RoutingPolicySection({ config, updateField, t }) {
  return (
    <AccordionSection id="workspace-routing" title={t("workspace.routing.title", "Routing Domain")} desc={t("workspace.routing.desc", "Manage enablement, allowed fields, and image polling behavior.") } group="workspace-sections">
      <div className="form-grid">
        <Field path="routing.routeProfiles.chatCompletions.allowedRequestFields" label={t("field.routeChatAllowedFields", "Chat Allowed Fields")}>
          <ListInput value={getValueByPath(config, "routing.routeProfiles.chatCompletions.allowedRequestFields")} onChange={(value) => updateField("routing.routeProfiles.chatCompletions.allowedRequestFields", value)} />
        </Field>
        <Field path="routing.routeProfiles.responses.allowedRequestFields" label={t("field.routeResponsesAllowedFields", "Responses Allowed Fields")}>
          <ListInput value={getValueByPath(config, "routing.routeProfiles.responses.allowedRequestFields")} onChange={(value) => updateField("routing.routeProfiles.responses.allowedRequestFields", value)} />
        </Field>
        <Field path="routing.routeProfiles.messages.allowedRequestFields" label={t("field.routeMessagesAllowedFields", "Messages Allowed Fields")}>
          <ListInput value={getValueByPath(config, "routing.routeProfiles.messages.allowedRequestFields")} onChange={(value) => updateField("routing.routeProfiles.messages.allowedRequestFields", value)} />
        </Field>
        <Field path="compatibility.anthropic.betaAllowlist" label={t("field.anthropicBetaAllowlist", "Anthropic Beta Allowlist")}>
          <ListInput value={getValueByPath(config, "compatibility.anthropic.betaAllowlist")} onChange={(value) => updateField("compatibility.anthropic.betaAllowlist", value)} />
        </Field>
        <Field path="compatibility.anthropic.unknownBetaPolicy" label={t("field.anthropicUnknownBetaPolicy", "Unknown Anthropic Beta Policy")}>
          <select value={getValueByPath(config, "compatibility.anthropic.unknownBetaPolicy") || "allow-direct-anthropic"} onChange={(event) => updateField("compatibility.anthropic.unknownBetaPolicy", event.target.value)}>
            <option value="passthrough">{t("option.anthropicBetaPassthrough", "Forward all beta values")}</option>
            <option value="allow-direct-anthropic">{t("option.anthropicBetaDirect", "Allow for direct Anthropic upstreams")}</option>
            <option value="allowlist">{t("option.anthropicBetaAllowlist", "Require allowlist for every upstream")}</option>
          </select>
        </Field>
        <Field path="routing.routeProfiles.imageGenerations.allowedRequestFields" label={t("field.routeImagesAllowedFields", "Image Allowed Fields")}>
          <ListInput value={getValueByPath(config, "routing.routeProfiles.imageGenerations.allowedRequestFields")} onChange={(value) => updateField("routing.routeProfiles.imageGenerations.allowedRequestFields", value)} />
        </Field>
        <Field path="routing.routeProfiles.imageGenerations.polling.intervalMs" label={t("field.routeImagesPollInterval", "Image Poll Interval ms")}>
          <input type="number" value={getValueByPath(config, "routing.routeProfiles.imageGenerations.polling.intervalMs") || 0} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.polling.intervalMs", asNumber(event.target.value))} />
        </Field>
        <Field path="routing.routeProfiles.imageGenerations.polling.timeoutMs" label={t("field.routeImagesPollTimeout", "Image Poll Timeout ms")}>
          <input type="number" value={getValueByPath(config, "routing.routeProfiles.imageGenerations.polling.timeoutMs") || 0} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.polling.timeoutMs", asNumber(event.target.value))} />
        </Field>
      </div>
      <div className="checkbox-row">
        <SettingLabel path="routing.routeProfiles.chatCompletions.enabled"><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.chatCompletions.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.chatCompletions.enabled", event.target.checked)} /> {t("field.routeChatEnabled", "Enable chat/completions")}</SettingLabel>
        <SettingLabel path="routing.routeProfiles.responses.enabled"><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.responses.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.responses.enabled", event.target.checked)} /> {t("field.routeResponsesEnabled", "Enable responses")}</SettingLabel>
        <SettingLabel path="routing.routeProfiles.messages.enabled"><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.messages.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.messages.enabled", event.target.checked)} /> {t("field.routeMessagesEnabled", "Enable messages")}</SettingLabel>
        <SettingLabel path="compatibility.protocolShim.rejectLossyRequests"><input type="checkbox" checked={getValueByPath(config, "compatibility.protocolShim.rejectLossyRequests") === true} onChange={(event) => updateField("compatibility.protocolShim.rejectLossyRequests", event.target.checked)} /> {t("field.protocolShimRejectLossyRequests", "Reject lossy shim requests")}</SettingLabel>
        <SettingLabel path="compatibility.protocolShim.rejectLossyResponses"><input type="checkbox" checked={getValueByPath(config, "compatibility.protocolShim.rejectLossyResponses") === true} onChange={(event) => updateField("compatibility.protocolShim.rejectLossyResponses", event.target.checked)} /> {t("field.protocolShimRejectLossyResponses", "Reject lossy shim responses")}</SettingLabel>
        <SettingLabel path="compatibility.anthropic.forwardSdkMetadataHeaders"><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.forwardSdkMetadataHeaders") !== false} onChange={(event) => updateField("compatibility.anthropic.forwardSdkMetadataHeaders", event.target.checked)} /> {t("field.anthropicForwardSdkMetadata", "Forward Anthropic SDK metadata headers")}</SettingLabel>
        <SettingLabel path="compatibility.anthropic.normalizeManualThinkingToolChoice"><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.normalizeManualThinkingToolChoice") !== false} onChange={(event) => updateField("compatibility.anthropic.normalizeManualThinkingToolChoice", event.target.checked)} /> {t("field.anthropicThinkingToolChoice", "Normalize manual thinking tool choice")}</SettingLabel>
        <SettingLabel path="compatibility.anthropic.sanitizeCacheControl"><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.sanitizeCacheControl") !== false} onChange={(event) => updateField("compatibility.anthropic.sanitizeCacheControl", event.target.checked)} /> {t("field.anthropicCacheControl", "Sanitize Anthropic cache controls")}</SettingLabel>
        <SettingLabel path="compatibility.anthropic.validateThinkingByModel"><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.validateThinkingByModel") !== false} onChange={(event) => updateField("compatibility.anthropic.validateThinkingByModel", event.target.checked)} /> {t("field.anthropicThinkingByModel", "Validate thinking mode by model")}</SettingLabel>
        <SettingLabel path="routing.routeProfiles.imageGenerations.enabled"><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.imageGenerations.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.enabled", event.target.checked)} /> {t("field.routeImagesEnabled", "Enable image generations")}</SettingLabel>
      </div>
    </AccordionSection>
  );
}