import { AccordionSection, Field } from "./ui.jsx";
import { getValueByPath, parseList, formatList } from "../utils.js";

function asNumber(value) {
  return Number(value || 0);
}

const transportFields = {
  http: [
    ["maxUploadBytes", "HTTP Upload Limit Bytes", 26214400],
    ["maxResponseBytes", "HTTP Response Limit Bytes", 104857600],
    ["maxFiles", "HTTP File Count", 10],
    ["maxFields", "HTTP Field Count", 64],
    ["maxFieldBytes", "HTTP Field Limit Bytes", 65536],
    ["maxConcurrentUploads", "HTTP Concurrent Uploads", 4],
    ["maxBufferedUploadBytes", "HTTP Upload Pool Bytes", 314572800],
    ["uploadTimeoutMs", "HTTP Upload Timeout ms", 60000]
  ],
  realtime: [
    ["maxConnections", "Realtime Connection Limit", 100],
    ["maxMessageBytes", "Realtime Message Limit Bytes", 8388608],
    ["maxBufferedBytes", "Realtime Send Buffer Bytes", 16777216],
    ["handshakeTimeoutMs", "Realtime Handshake Timeout ms", 10000],
    ["initialConfigTimeoutMs", "Realtime Initial Config Timeout ms", 10000],
    ["maxInitialConfigBytes", "Realtime Initial Config Bytes", 65536],
    ["idleTimeoutMs", "Realtime Idle Timeout ms", 60000],
    ["maxSessionMs", "Realtime Session Limit ms", 3600000],
    ["heartbeatMs", "Realtime Heartbeat Interval ms", 30000]
  ],
  webrtc: [
    ["maxCalls", "WebRTC Call Limit", 100],
    ["maxSetupBytes", "WebRTC Setup Limit Bytes", 262144],
    ["maxResponseBytes", "WebRTC Response Limit Bytes", 262144],
    ["setupTimeoutMs", "WebRTC Setup Timeout ms", 15000],
    ["callTtlMs", "WebRTC Call TTL ms", 3600000],
    ["clientSecretTtlSeconds", "Client Secret TTL Seconds", 60]
  ]
};

export default function MediaPolicySection({ config, updateField, t }) {
  const compressionEnabled = getValueByPath(config, "media.inputCompression.enabled") === true;
  const compressionMode = getValueByPath(config, "media.inputCompression.mode") || "legacy";
  const remoteImagesEnabled = getValueByPath(config, "media.remoteImages.allow") === true;
  const generationEnabled = getValueByPath(config, "media.generation.enabled") === true;

  return (
    <AccordionSection id="workspace-media" title={t("workspace.media.title", "Media Policy")} desc={t("workspace.media.desc", "Control input compression, remote images, inline images, and image generation defaults.") } group="workspace-sections">
      <div className="form-grid">
        {Object.entries(transportFields).flatMap(([transport, fields]) => getValueByPath(config, `media.${transport}.enabled`) === true
          ? fields.map(([field, label, defaultValue]) => <Field key={`${transport}.${field}`} label={t(`mediaLimit.${transport}.${field}`, label)}>
            <input type="number" min={field === "clientSecretTtlSeconds" ? 10 : 1} max={field === "clientSecretTtlSeconds" ? 7200 : 2147483647}
              step="1" value={getValueByPath(config, `media.${transport}.${field}`) ?? defaultValue}
              onChange={(event) => updateField(`media.${transport}.${field}`, asNumber(event.target.value))} />
          </Field>) : [])}
        {compressionEnabled ? <Field label={t("field.mediaCompressionMode", "Compression Mode")}>
          <select value={compressionMode} onChange={(event) => updateField("media.inputCompression.mode", event.target.value)}>
            <option value="legacy">{t("option.mediaLegacy", "Legacy")}</option>
            <option value="preserve">{t("option.mediaPreserve", "Preserve Original")}</option>
            <option value="adaptive">{t("option.mediaAdaptive", "Adaptive JPEG")}</option>
          </select>
        </Field> : null}
        {compressionEnabled && compressionMode !== "preserve" ? <><Field label={t("field.mediaMaxLongSide", "Max Long Side px")}>
          <input type="number" value={getValueByPath(config, "media.inputCompression.maxLongSidePx") || 0} onChange={(event) => updateField("media.inputCompression.maxLongSidePx", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.mediaQuality", "Quality")}>
          <input type="number" step="0.05" min="0" max="1" value={getValueByPath(config, "media.inputCompression.quality") || 0} onChange={(event) => updateField("media.inputCompression.quality", Number(event.target.value || 0))} />
        </Field>
        <Field label={t("field.mediaMinQuality", "Min Quality")}>
          <input type="number" step="0.05" min="0" max="1" value={getValueByPath(config, "media.inputCompression.minQuality") || 0} onChange={(event) => updateField("media.inputCompression.minQuality", Number(event.target.value || 0))} />
        </Field>
        {compressionMode === "legacy" ? <Field label={t("field.mediaOutputFormat", "Output Format")}>
          <select value={getValueByPath(config, "media.inputCompression.outputFormat") || "jpeg"} onChange={(event) => updateField("media.inputCompression.outputFormat", event.target.value)}>
            <option value="jpeg">{t("option.jpeg", "jpeg")}</option>
            <option value="webp">{t("option.webp", "webp")}</option>
          </select>
        </Field> : null}</> : null}
        {compressionEnabled && compressionMode === "adaptive" ? [
          ["minBytes", "field.mediaMinBytes", "Minimum Input Bytes", 262144, 0, undefined, 1],
          ["minSavingsRatio", "field.mediaMinSavings", "Minimum Savings Ratio", 0.1, 0, 1, 0.05],
          ["maxPixels", "field.mediaMaxPixels", "Decode Pixel Limit", 40000000, 1, 268402689, 1],
          ["maxConcurrent", "field.mediaMaxConcurrent", "Concurrent Encoders", 2, 1, 32, 1],
          ["maxQueue", "field.mediaMaxQueue", "Queue Capacity", 8, 0, 256, 1],
          ["timeoutMs", "field.mediaTimeout", "Preparation Budget ms", 5000, 1, 60000, 1]
        ].map(([field, label, fallback, defaultValue, min, max, step]) => (
          <Field key={field} label={t(label, fallback)}>
            <input type="number" min={min} max={max} step={step} value={getValueByPath(config, `media.inputCompression.${field}`) ?? defaultValue} onChange={(event) => updateField(`media.inputCompression.${field}`, asNumber(event.target.value))} />
          </Field>
        )) : null}
        {remoteImagesEnabled ? <><Field label={t("field.remoteImagesMaxMb", "Remote Download Limit MB")}>
          <input type="number" value={getValueByPath(config, "media.remoteImages.maxDownloadSizeMb") || 0} onChange={(event) => updateField("media.remoteImages.maxDownloadSizeMb", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.remoteImagesTimeoutMs", "Remote Timeout ms")}>
          <input type="number" value={getValueByPath(config, "media.remoteImages.timeoutMs") || 0} onChange={(event) => updateField("media.remoteImages.timeoutMs", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.remoteImagesMimeTypes", "Remote Allowed MIME Types")}>
          <input value={formatList(getValueByPath(config, "media.remoteImages.allowedMimeTypes"))} onChange={(event) => updateField("media.remoteImages.allowedMimeTypes", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.remoteImagesHosts", "Remote Allowed Hosts")}>
          <input value={formatList(getValueByPath(config, "media.remoteImages.allowedHosts"))} onChange={(event) => updateField("media.remoteImages.allowedHosts", parseList(event.target.value))} />
        </Field></> : null}
        <Field label={t("field.inlineImagesMaxBase64", "Inline Max Base64 Bytes")}>
          <input type="number" value={getValueByPath(config, "media.inlineImages.maxBase64Bytes") || 0} onChange={(event) => updateField("media.inlineImages.maxBase64Bytes", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.inlineImagesMaxCount", "Image Count Limit (0 = unlimited)")}>
          <input type="number" min="0" step="1" value={getValueByPath(config, "media.inlineImages.maxImages") ?? 0} onChange={(event) => updateField("media.inlineImages.maxImages", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.inlineImagesMaxTotal", "Total Inline Bytes (0 = unlimited)")}>
          <input type="number" min="0" step="1" value={getValueByPath(config, "media.inlineImages.maxTotalBytes") ?? 0} onChange={(event) => updateField("media.inlineImages.maxTotalBytes", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.inlineImagesPreview", "Inline Log Preview Chars")}>
          <input type="number" value={getValueByPath(config, "media.inlineImages.logPreviewChars") || 0} onChange={(event) => updateField("media.inlineImages.logPreviewChars", asNumber(event.target.value))} />
        </Field>
        {generationEnabled ? <><Field label={t("field.mediaGenerationDefaultModel", "Default Generation Model")}>
          <input value={getValueByPath(config, "media.generation.defaultModel") || ""} onChange={(event) => updateField("media.generation.defaultModel", event.target.value)} />
        </Field>
        <Field label={t("field.mediaGenerationRequestTimeout", "Generation Request Timeout ms")}>
          <input type="number" value={getValueByPath(config, "media.generation.requestTimeoutMs") || 0} onChange={(event) => updateField("media.generation.requestTimeoutMs", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.mediaGenerationPollInterval", "Generation Poll Interval ms")}>
          <input type="number" value={getValueByPath(config, "media.generation.pollIntervalMs") || 0} onChange={(event) => updateField("media.generation.pollIntervalMs", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.mediaGenerationPollTimeout", "Generation Poll Timeout ms")}>
          <input type="number" value={getValueByPath(config, "media.generation.pollTimeoutMs") || 0} onChange={(event) => updateField("media.generation.pollTimeoutMs", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.mediaGenerationMaxImages", "Max Images")}>
          <input type="number" value={getValueByPath(config, "media.generation.maxImages") || 0} onChange={(event) => updateField("media.generation.maxImages", asNumber(event.target.value))} />
        </Field>
        <Field label={t("field.mediaGenerationAllowedSizes", "Allowed Sizes")}>
          <input value={formatList(getValueByPath(config, "media.generation.allowedSizes"))} onChange={(event) => updateField("media.generation.allowedSizes", parseList(event.target.value))} />
        </Field>
        <Field label={t("field.mediaGenerationAllowedQualityModes", "Allowed Quality Modes")}>
          <input value={formatList(getValueByPath(config, "media.generation.allowedQualityModes"))} onChange={(event) => updateField("media.generation.allowedQualityModes", parseList(event.target.value))} />
        </Field></> : null}
      </div>
      <div className="checkbox-row">
        <label><input type="checkbox" checked={getValueByPath(config, "media.http.enabled") === true} onChange={(event) => updateField("media.http.enabled", event.target.checked)} /> {t("field.mediaHttpEnabled", "Enable HTTP Audio and Image Edits")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.realtime.enabled") === true} onChange={(event) => updateField("media.realtime.enabled", event.target.checked)} /> {t("field.mediaRealtimeEnabled", "Enable Realtime WebSocket")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.webrtc.enabled") === true} onChange={(event) => updateField("media.webrtc.enabled", event.target.checked)} /> {t("field.mediaWebRtcEnabled", "Enable WebRTC Setup and Control")}</label>
        {getValueByPath(config, "media.webrtc.enabled") === true ? <label><input type="checkbox" checked={getValueByPath(config, "media.webrtc.allowClientSecrets") === true} onChange={(event) => {
          if (event.target.checked && !window.confirm(t("confirm.mediaClientSecrets", "Exported provider credentials can create multiple sessions and bypass proxy controls. Expiration does not end active sessions. Continue?"))) return;
          updateField("media.webrtc.allowClientSecrets", event.target.checked);
        }} /> {t("field.mediaClientSecrets", "Export Upstream Client Secrets")}</label> : null}
        <label><input type="checkbox" checked={getValueByPath(config, "media.inputCompression.enabled") === true} onChange={(event) => updateField("media.inputCompression.enabled", event.target.checked)} /> {t("field.mediaCompressionEnabled", "Enable Input Compression")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.inputCompression.progressive") === true} onChange={(event) => updateField("media.inputCompression.progressive", event.target.checked)} /> {t("field.mediaProgressive", "Progressive")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.inputCompression.useMozJpeg") === true} onChange={(event) => updateField("media.inputCompression.useMozJpeg", event.target.checked)} /> {t("field.mediaMozJpeg", "Prefer mozjpeg")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.remoteImages.allow") === true} onChange={(event) => updateField("media.remoteImages.allow", event.target.checked)} /> {t("field.remoteImagesAllow", "Allow Remote Images")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.inlineImages.redactInLogs") === true} onChange={(event) => updateField("media.inlineImages.redactInLogs", event.target.checked)} /> {t("field.inlineImagesRedact", "Redact Inline Image Logs")}</label>
        <label><input type="checkbox" checked={getValueByPath(config, "media.generation.enabled") === true} onChange={(event) => updateField("media.generation.enabled", event.target.checked)} /> {t("field.mediaGenerationEnabled", "Enable Image Generation Route")}</label>
      </div>
    </AccordionSection>
  );
}