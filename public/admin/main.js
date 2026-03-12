import {
  getConfigApi,
  saveConfigApi,
  reloadConfigApi,
  getRuntimeApi,
  verifyAadApi,
  getStatsApi,
  getLogsApi,
  getCaddyStatusApi,
  restartServiceApi,
  sendProxyRequestApi
} from "./api.js";

    const { setLanguage, t, getStoredLang, applyI18n } = window.I18N;
    const configArea = document.getElementById("configArea");
    const configMsg = document.getElementById("configMsg");
    const configDirtyBadge = document.getElementById("configDirtyBadge");
    const configValidityBadge = document.getElementById("configValidityBadge");
    const configDiffSummary = document.getElementById("configDiffSummary");
    const configValidationSummary = document.getElementById("configValidationSummary");
    const configDiffPreview = document.getElementById("configDiffPreview");
    const runtimeInfo = document.getElementById("runtimeInfo");
    const verifyMsg = document.getElementById("verifyMsg");
    const summaryProxyBadge = document.getElementById("summaryProxyBadge");
    const summaryProxyValue = document.getElementById("summaryProxyValue");
    const summaryProxyNote = document.getElementById("summaryProxyNote");
    const summaryAadBadge = document.getElementById("summaryAadBadge");
    const summaryAadValue = document.getElementById("summaryAadValue");
    const summaryAadNote = document.getElementById("summaryAadNote");
    const summaryConfigBadge = document.getElementById("summaryConfigBadge");
    const summaryConfigValue = document.getElementById("summaryConfigValue");
    const summaryConfigNote = document.getElementById("summaryConfigNote");
    const summaryRuntimeBadge = document.getElementById("summaryRuntimeBadge");
    const summaryRuntimeValue = document.getElementById("summaryRuntimeValue");
    const summaryRuntimeNote = document.getElementById("summaryRuntimeNote");
    const statTotals = document.getElementById("statTotals");
    const statTimestamp = document.getElementById("statTimestamp");
    const modelRows = document.getElementById("modelRows");
    const logLevelWarn = document.getElementById("logLevelWarn");
    const logLevelError = document.getElementById("logLevelError");
    const logLevelInfo = document.getElementById("logLevelInfo");
    const logAutoRefresh = document.getElementById("logAutoRefresh");
    const logEventInput = document.getElementById("logEventInput");
    const logModelInput = document.getElementById("logModelInput");
    const logRequestIdInput = document.getElementById("logRequestIdInput");
    const logKeywordInput = document.getElementById("logKeywordInput");
    const logLimitSelect = document.getElementById("logLimitSelect");
    const logSummary = document.getElementById("logSummary");
    const logList = document.getElementById("logList");
    const payloadArea = document.getElementById("payloadArea");
    const responseArea = document.getElementById("responseArea");
    const compressEnabled = document.getElementById("compressEnabled");
    const compressPreset = document.getElementById("compressPreset");
    const compressStats = document.getElementById("compressStats");
    const imageFileInput = document.getElementById("imageFileInput");
    const imageFileInfo = document.getElementById("imageFileInfo");
    const payloadNote = document.getElementById("payloadNote");
    const applyCompressConfigBtn = document.getElementById("applyCompressConfigBtn");
    const caddyEnabled = document.getElementById("caddyEnabled");
    const caddyDomain = document.getElementById("caddyDomain");
    const caddyEmail = document.getElementById("caddyEmail");
    const caddyHttpsPort = document.getElementById("caddyHttpsPort");
    const caddyUpstreamHost = document.getElementById("caddyUpstreamHost");
    const caddyUpstreamPort = document.getElementById("caddyUpstreamPort");
    const caddyDialTimeoutMs = document.getElementById("caddyDialTimeoutMs");
    const caddyResponseHeaderTimeoutMs = document.getElementById("caddyResponseHeaderTimeoutMs");
    const caddyKeepAliveTimeoutMs = document.getElementById("caddyKeepAliveTimeoutMs");
    const caddyPreview = document.getElementById("caddyPreview");
    const caddyMsg = document.getElementById("caddyMsg");
    const caddyState = document.getElementById("caddyState");
    const caddyStateMsg = document.getElementById("caddyStateMsg");
    const caddyLastWrite = document.getElementById("caddyLastWrite");
    const caddyLastReload = document.getElementById("caddyLastReload");
    const caddyLastError = document.getElementById("caddyLastError");
    let logsRefreshTimer = null;
    let configMsgState = null;
    let latestStats = null;
    let latestRuntime = null;
    let latestCaddyStatus = null;
    let lastLoadedConfigObject = null;
    let lastConfigInspection = { validJson: true, issues: [], diff: { added: [], removed: [], changed: [] } };
    let aadStatus = { state: "unchecked", detail: "", checkedAt: "" };

    function setConfigMessageState(state) {
      configMsgState = state;
      renderConfigMessage();
    }

    function renderConfigMessage() {
      if (!configMsgState) {
        configMsg.textContent = "";
        return;
      }
      if (configMsgState.kind === "key") {
        configMsg.textContent = t(configMsgState.key);
        return;
      }
      if (configMsgState.kind === "error") {
        configMsg.textContent = `${t(configMsgState.prefixKey)}: ${configMsgState.detail || "Unknown"}`;
      }
    }

    function fillTemplate(template, values = {}) {
      return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
    }

    function setPill(el, tone, text) {
      el.className = `status-pill ${tone}`;
      el.textContent = text;
    }

    function safeParseJson(text) {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (error) {
        return { ok: false, error };
      }
    }

    function flattenConfig(value, prefix = "", out = {}) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          flattenConfig(item, `${prefix}[${index}]`, out);
        });
        if (!value.length && prefix) {
          out[prefix] = "[]";
        }
        return out;
      }
      if (value && typeof value === "object") {
        const entries = Object.entries(value);
        if (!entries.length && prefix) {
          out[prefix] = "{}";
          return out;
        }
        entries.forEach(([key, child]) => {
          const nextPrefix = prefix ? `${prefix}.${key}` : key;
          flattenConfig(child, nextPrefix, out);
        });
        return out;
      }
      if (prefix) {
        out[prefix] = JSON.stringify(value);
      }
      return out;
    }

    function computeConfigDiff(prevConfig, nextConfig) {
      const prevFlat = flattenConfig(prevConfig || {});
      const nextFlat = flattenConfig(nextConfig || {});
      const keys = new Set([...Object.keys(prevFlat), ...Object.keys(nextFlat)]);
      const diff = { added: [], removed: [], changed: [] };
      Array.from(keys).sort().forEach((key) => {
        if (!(key in prevFlat)) {
          diff.added.push(key);
          return;
        }
        if (!(key in nextFlat)) {
          diff.removed.push(key);
          return;
        }
        if (prevFlat[key] !== nextFlat[key]) {
          diff.changed.push(key);
        }
      });
      return diff;
    }

    function inspectConfigStructure(config) {
      const issues = [];
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return ["Root config must be an object"];
      }
      if (!config.server || typeof config.server !== "object") {
        issues.push("server must be an object");
      }
      if (!config.auth || typeof config.auth !== "object") {
        issues.push("auth must be an object");
      }
      if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) {
        issues.push("apiKeys must be a non-empty array");
      }
      if (!Array.isArray(config.upstreams) || config.upstreams.length === 0) {
        issues.push("upstreams must be a non-empty array");
      }
      if (!Array.isArray(config.models) || config.models.length === 0) {
        issues.push("models must be a non-empty array");
      }
      return issues;
    }

    function summarizeDiff(diff) {
      return diff.added.length + diff.removed.length + diff.changed.length;
    }

    function formatDiffPath(path, kind) {
      const marker = kind === "added" ? "+" : kind === "removed" ? "-" : "~";
      return `${marker} ${path}`;
    }

    function updateConfigEditorState() {
      const currentText = configArea.value || "";
      const parsed = safeParseJson(currentText);
      if (!parsed.ok) {
        lastConfigInspection = { validJson: false, issues: [parsed.error.message], diff: { added: [], removed: [], changed: [] } };
        setPill(configDirtyBadge, isConfigDirty() ? "warn" : "neutral", t(isConfigDirty() ? "config.state.dirty" : "config.state.clean"));
        setPill(configValidityBadge, "error", t("config.validity.invalid"));
        configDiffSummary.textContent = t("config.diff.none");
        configValidationSummary.textContent = parsed.error.message;
        configDiffPreview.textContent = t("summary.config.invalid");
        renderSummaryCards();
        return;
      }

      const issues = inspectConfigStructure(parsed.value);
      const diff = computeConfigDiff(lastLoadedConfigObject || {}, parsed.value);
      lastConfigInspection = { validJson: true, issues, diff };

      setPill(configDirtyBadge, isConfigDirty() ? "warn" : "good", t(isConfigDirty() ? "config.state.dirty" : "config.state.clean"));
      setPill(configValidityBadge, issues.length ? "warn" : "good", t(issues.length ? "config.validity.invalid" : "config.validity.valid"));

      const diffCount = summarizeDiff(diff);
      configDiffSummary.textContent = `${t("config.diff.summary")}: ${diffCount}`;
      configValidationSummary.textContent = issues.length
        ? `${t("config.validation.issueCount")}: ${issues.length}`
        : t("config.validation.ok");

      if (!diffCount) {
        configDiffPreview.textContent = `${t("config.diff.previewTitle")}: ${t("config.diff.none")}`;
      } else {
        const lines = [t("config.diff.previewTitle")];
        diff.added.slice(0, 4).forEach((path) => lines.push(formatDiffPath(path, "added")));
        diff.changed.slice(0, 4).forEach((path) => lines.push(formatDiffPath(path, "changed")));
        diff.removed.slice(0, 4).forEach((path) => lines.push(formatDiffPath(path, "removed")));
        configDiffPreview.textContent = lines.join("\n");
      }

      renderSummaryCards();
    }

    function renderSummaryCards() {
      if (latestStats) {
        const totals = latestStats.totals || {};
        setPill(summaryProxyBadge, totals.errors > 0 ? "warn" : "good", t(totals.errors > 0 ? "summary.state.warn" : "summary.state.good"));
        summaryProxyValue.textContent = t("summary.proxy.online");
        summaryProxyNote.textContent = fillTemplate(t("summary.proxy.note"), {
          requests: totals.requests || 0,
          errors: totals.errors || 0
        });
      } else {
        setPill(summaryProxyBadge, "neutral", t("summary.state.neutral"));
        summaryProxyValue.textContent = "-";
        summaryProxyNote.textContent = "";
      }

      const aadTone = aadStatus.state === "ok" ? "good" : aadStatus.state === "failed" ? "error" : "neutral";
      const aadTextKey = aadStatus.state === "ok"
        ? "summary.aad.ok"
        : aadStatus.state === "failed"
          ? "summary.aad.failed"
          : "summary.aad.unchecked";
      setPill(summaryAadBadge, aadTone, t(aadTextKey));
      summaryAadValue.textContent = t(aadTextKey);
      summaryAadNote.textContent = aadStatus.detail || t("summary.aad.note.unchecked");

      if (!lastLoadedConfigObject && !configArea.value) {
        setPill(summaryConfigBadge, "neutral", t("summary.state.neutral"));
        summaryConfigValue.textContent = "-";
        summaryConfigNote.textContent = "";
      } else if (!lastConfigInspection.validJson) {
        setPill(summaryConfigBadge, "error", t("summary.state.error"));
        summaryConfigValue.textContent = t("summary.config.invalid");
        summaryConfigNote.textContent = fillTemplate(t("summary.config.note"), {
          count: summarizeDiff(lastConfigInspection.diff),
          issues: lastConfigInspection.issues.length
        });
      } else if (isConfigDirty()) {
        setPill(summaryConfigBadge, "warn", t("summary.state.warn"));
        summaryConfigValue.textContent = t("summary.config.dirty");
        summaryConfigNote.textContent = fillTemplate(t("summary.config.note"), {
          count: summarizeDiff(lastConfigInspection.diff),
          issues: lastConfigInspection.issues.length
        });
      } else {
        setPill(summaryConfigBadge, lastConfigInspection.issues.length ? "warn" : "good", t(lastConfigInspection.issues.length ? "summary.state.warn" : "summary.state.good"));
        summaryConfigValue.textContent = t("summary.config.clean");
        summaryConfigNote.textContent = fillTemplate(t("summary.config.note"), {
          count: summarizeDiff(lastConfigInspection.diff),
          issues: lastConfigInspection.issues.length
        });
      }

      if (latestRuntime || latestCaddyStatus) {
        const mode = latestRuntime?.activeMode || latestRuntime?.mode || "-";
        const caddyState = latestCaddyStatus?.state || "disabled";
        const runtimeTone = latestRuntime?.blobAccessState === "degraded" || caddyState === "error"
          ? "warn"
          : "good";
        setPill(summaryRuntimeBadge, runtimeTone, t(runtimeTone === "good" ? "summary.state.good" : "summary.state.warn"));
        summaryRuntimeValue.textContent = fillTemplate(t("summary.runtime.value"), {
          mode,
          caddy: t(`caddy.state.${caddyState}`)
        });
        summaryRuntimeNote.textContent = fillTemplate(t("summary.runtime.note"), {
          sync: t(`runtime.syncState.${latestRuntime?.pendingBlobSync ? "pending" : "clean"}.short`),
          blob: t(`runtime.blobAccessState.${latestRuntime?.blobAccessState || "unknown"}.short`)
        });
      } else {
        setPill(summaryRuntimeBadge, "neutral", t("summary.state.neutral"));
        summaryRuntimeValue.textContent = "-";
        summaryRuntimeNote.textContent = "";
      }
    }

    function resetPayloadSample() {
      payloadArea.value = JSON.stringify({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: t("payload.greeting") }],
        stream: false
      }, null, 2);
    }

    let lastLoadedConfigText = "";

    function setLoadedConfigText() {
      lastLoadedConfigText = configArea.value || "";
    }

    function isConfigDirty() {
      return (configArea.value || "") !== (lastLoadedConfigText || "");
    }

    function pickPresetFromConfig(cfg) {
      const maxSize = Number.isFinite(cfg?.maxSize) ? cfg.maxSize : 1600;
      if (maxSize >= 1500) return "light";
      if (maxSize >= 1200) return "standard";
      return "strong";
    }

    function hydrateCompressionFromConfig(config) {
      const cfg = config?.server?.imageCompression || {};
      compressEnabled.checked = cfg.enabled !== false;
      compressPreset.value = pickPresetFromConfig(cfg);
    }

    async function loadConfig() {
      const json = await getConfigApi();
      configArea.value = JSON.stringify(json, null, 2);
      setConfigMessageState({ kind: "key", key: "msg.loaded" });
      hydrateCaddyForm(json);
      hydrateCompressionFromConfig(json);
      lastLoadedConfigObject = json;
      setLoadedConfigText();
      updateConfigEditorState();
    }

    async function saveConfig() {
      try {
        const next = JSON.parse(configArea.value);
        const issues = inspectConfigStructure(next);
        if (issues.length && !window.confirm(`${t("config.validation.confirm")}\n- ${issues.slice(0, 5).join("\n- ")}`)) {
          return;
        }
        const json = await saveConfigApi(next);
        if (json.ok) {
          setConfigMessageState({ kind: "key", key: "msg.saved" });
          configArea.value = JSON.stringify(json.config, null, 2);
          hydrateCaddyForm(json.config);
          hydrateCompressionFromConfig(json.config);
          lastLoadedConfigObject = json.config;
          setLoadedConfigText();
          updateConfigEditorState();
        } else {
          setConfigMessageState({
            kind: "error",
            prefixKey: "msg.saveFailed",
            detail: json.error || "Unknown"
          });
        }
      } catch (e) {
        setConfigMessageState({
          kind: "error",
          prefixKey: "msg.saveFailed",
          detail: t("msg.invalidJson")
        });
      }
    }

    async function reloadConfig() {
      const json = await reloadConfigApi();
      if (json.ok) {
        configArea.value = JSON.stringify(json.config, null, 2);
        setConfigMessageState({ kind: "key", key: "msg.reloadSuccess" });
        hydrateCaddyForm(json.config);
        hydrateCompressionFromConfig(json.config);
        lastLoadedConfigObject = json.config;
        setLoadedConfigText();
        updateConfigEditorState();
      } else {
        setConfigMessageState({
          kind: "error",
          prefixKey: "msg.reloadFailed",
          detail: json.error || "Unknown"
        });
      }
    }

    function buildCaddyConfigFromForm() {
      return {
        enabled: !!caddyEnabled.checked,
        domain: caddyDomain.value.trim(),
        email: caddyEmail.value.trim(),
        httpsPort: Number(caddyHttpsPort.value || 443),
        upstreamHost: caddyUpstreamHost.value.trim() || "127.0.0.1",
        upstreamPort: Number(caddyUpstreamPort.value || 3000),
        transport: {
          dialTimeoutMs: Number(caddyDialTimeoutMs.value || 5000),
          responseHeaderTimeoutMs: Number(caddyResponseHeaderTimeoutMs.value || 45000),
          keepAliveTimeoutMs: Number(caddyKeepAliveTimeoutMs.value || 120000)
        }
      };
    }

    function msToCaddyDuration(ms, fallbackMs) {
      const value = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
      return `${Math.max(1, Math.ceil(value / 1000))}s`;
    }

    function renderCaddyPreview() {
      const cfg = buildCaddyConfigFromForm();
      if (!cfg.enabled) {
        caddyPreview.textContent = t("caddy.preview.disabled");
        return;
      }
      const hostPort = `${cfg.domain}:${cfg.httpsPort}`;
      const upstream = `${cfg.upstreamHost}:${cfg.upstreamPort}`;
      const dialTimeout = msToCaddyDuration(cfg.transport?.dialTimeoutMs, 5000);
      const responseHeaderTimeout = msToCaddyDuration(cfg.transport?.responseHeaderTimeoutMs, 45000);
      const keepAliveTimeout = msToCaddyDuration(cfg.transport?.keepAliveTimeoutMs, 120000);
      caddyPreview.textContent = `{
  email ${cfg.email}
  servers :80 {
    protocols h1
  }
  servers {
    protocols h1 h2 h3
  }
}

${hostPort} {
  encode zstd gzip
  reverse_proxy ${upstream} {
    flush_interval -1
    health_uri /healthz
    health_interval 30s
    fail_duration 30s
    transport http {
      dial_timeout ${dialTimeout}
      response_header_timeout ${responseHeaderTimeout}
      keepalive ${keepAliveTimeout}
      keepalive_idle_conns 256
      keepalive_idle_conns_per_host 128
      versions 2 1.1
    }
  }
}
`;
    }

    const compressionPresets = {
      light: { maxSize: 1600, quality: 0.85 },
      standard: { maxSize: 1280, quality: 0.8 },
      strong: { maxSize: 1024, quality: 0.7 }
    };

    function isDataUrl(value) {
      return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
    }

    function detectBase64Mime(value) {
      if (value.startsWith("/9j/")) return "image/jpeg";
      if (value.startsWith("iVBOR")) return "image/png";
      if (value.startsWith("UklGR")) return "image/webp";
      return null;
    }

    function collectImageTargets(value, results, parent, key) {
      if (typeof value === "string") {
        if (isDataUrl(value)) {
          results.push({ parent, key, value, type: "dataUrl" });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => collectImageTargets(item, results, value, index));
        return;
      }
      if (value && typeof value === "object") {
        Object.entries(value).forEach(([k, v]) => {
          if (typeof v === "string" && k === "image_base64" && !isDataUrl(v)) {
            const mime = detectBase64Mime(v);
            if (mime) {
              results.push({ parent: value, key: k, value: v, type: "base64", mime });
              return;
            }
          }
          collectImageTargets(v, results, value, k);
        });
      }
    }

    function estimateDataUrlBytes(dataUrl) {
      const base64 = dataUrl.split(",")[1] || "";
      return Math.floor((base64.length * 3) / 4);
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      let idx = 0;
      let val = bytes;
      while (val >= 1024 && idx < units.length - 1) {
        val /= 1024;
        idx += 1;
      }
      return `${val.toFixed(val >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
    }

    function updatePayloadAreaSafely(payload) {
      const json = JSON.stringify(payload, null, 2);
      if (json.length > 200000) {
        payloadNote.textContent = t("payload.tooLarge");
        return;
      }
      payloadNote.textContent = "";
      payloadArea.value = json;
    }

    function loadImage(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      });
    }

    async function compressDataUrl(dataUrl, preset) {
      const img = await loadImage(dataUrl);
      const maxSize = preset.maxSize;
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const targetW = Math.max(1, Math.round(img.width * scale));
      const targetH = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, targetW, targetH);
      return canvas.toDataURL("image/jpeg", preset.quality);
    }

    async function compressPayloadImages(payload) {
      const targets = [];
      collectImageTargets(payload, targets, null, null);
      if (!targets.length) {
        compressStats.textContent = t("compress.stats.none");
        return payload;
      }

      const preset = compressionPresets[compressPreset.value] || compressionPresets.standard;
      let before = 0;
      let after = 0;
      let count = 0;

      for (const target of targets) {
        let dataUrl = target.type === "base64" ? `data:${target.mime};base64,${target.value}` : target.value;
        before += estimateDataUrlBytes(dataUrl);
        try {
          const compressed = await compressDataUrl(dataUrl, preset);
          after += estimateDataUrlBytes(compressed);
          count += 1;
          if (target.type === "base64") {
            target.parent[target.key] = compressed.split(",")[1];
          } else {
            target.parent[target.key] = compressed;
          }
        } catch {
          // Skip compression failures and keep original
        }
      }

      compressStats.textContent = `${t("compress.stats")}: ${count}, ${formatBytes(before)} -> ${formatBytes(after)}`;
      return payload;
    }

    function insertPlaceholder(text) {
      const template = {
        model: "gpt-5-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: t("payload.greeting") },
              { type: "image_url", image_url: { url: text } }
            ]
          }
        ],
        stream: false
      };
      payloadArea.value = JSON.stringify(template, null, 2);
      payloadArea.focus();
    }

    function replacePlaceholders(value, dataUrl, base64, meta) {
      if (typeof value === "string") {
        if (value === "__IMAGE_DATA_URL__") {
          meta.replaced += 1;
          return dataUrl;
        }
        if (value === "__IMAGE_BASE64__") {
          meta.replaced += 1;
          return base64;
        }
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((item) => replacePlaceholders(item, dataUrl, base64, meta));
      }
      if (value && typeof value === "object") {
        const out = Array.isArray(value) ? [] : { ...value };
        Object.entries(value).forEach(([k, v]) => {
          out[k] = replacePlaceholders(v, dataUrl, base64, meta);
        });
        return out;
      }
      return value;
    }

    async function maybeInjectImageFromFile(payload) {
      const file = imageFileInput.files?.[0];
      if (!file) {
        imageFileInfo.textContent = t("compress.file.none");
        return payload;
      }
      imageFileInfo.textContent = `${t("compress.file.selected")}: ${file.name} (${formatBytes(file.size)})`;
      const preset = compressionPresets[compressPreset.value] || compressionPresets.standard;
      const originalDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      let dataUrl = originalDataUrl;
      if (compressEnabled.checked) {
        try {
          dataUrl = await compressDataUrl(originalDataUrl, preset);
        } catch {
          dataUrl = originalDataUrl;
        }
      }
      const base64 = dataUrl.split(",")[1] || "";
      const meta = { replaced: 0 };
      const next = replacePlaceholders(payload, dataUrl, base64, meta);
      if (meta.replaced === 0) {
        compressStats.textContent = t("compress.placeholder.missing");
        return next;
      }
      const beforeBytes = estimateDataUrlBytes(originalDataUrl);
      const afterBytes = estimateDataUrlBytes(dataUrl);
      compressStats.textContent = `${t("compress.stats")}: ${meta.replaced}, ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}`;
      return next;
    }

    function hydrateCaddyForm(config) {
      const cfg = config?.server?.caddy || {};
      caddyEnabled.checked = !!cfg.enabled;
      caddyDomain.value = cfg.domain || "";
      caddyEmail.value = cfg.email || "";
      caddyHttpsPort.value = cfg.httpsPort ?? 443;
      caddyUpstreamHost.value = cfg.upstreamHost || "127.0.0.1";
      caddyUpstreamPort.value = cfg.upstreamPort ?? 3000;
      caddyDialTimeoutMs.value = cfg.transport?.dialTimeoutMs ?? config?.server?.upstream?.connectTimeoutMs ?? 5000;
      caddyResponseHeaderTimeoutMs.value = cfg.transport?.responseHeaderTimeoutMs ?? config?.server?.upstream?.firstByteTimeoutMs ?? 45000;
      caddyKeepAliveTimeoutMs.value = cfg.transport?.keepAliveTimeoutMs ?? 120000;
      renderCaddyPreview();
    }

    async function loadRuntimeInfo() {
      const json = await getRuntimeApi();
      if (!json.ok) return;
      const runtime = json.runtime || {};
      latestRuntime = runtime;
      const lines = [];
      const configuredMode = runtime.mode || "azureFile";
      const activeMode = runtime.activeMode || configuredMode;
      const blobAccessState = runtime.blobAccessState || (configuredMode === "blob" ? "unknown" : "disabled");
      const path = runtime.configPath || "";
      const blobAccountUrl = runtime.blobAccountUrl || "";
      const blobContainer = runtime.blobContainerName || "";
      const blobName = runtime.configBlobName || "";
      const pendingBlobSync = !!runtime.pendingBlobSync;
      const lastBlobError = runtime.lastBlobError;

      lines.push(`${t("runtime.persistence")}: ${configuredMode}`);
      lines.push(`${t("runtime.activeMode")}: ${t(`runtime.activeMode.${activeMode}`)}`);
      lines.push(`${t("runtime.blobAccessState")}: ${t(`runtime.blobAccessState.${blobAccessState}`)}`);
      lines.push(`${t("runtime.syncState")}: ${pendingBlobSync ? t("runtime.syncState.pending") : t("runtime.syncState.clean")}`);
      lines.push(`${t("runtime.configPath")}: ${path}`);

      if (blobAccountUrl) {
        lines.push(`${t("runtime.blobAccountUrl")}: ${blobAccountUrl}`);
      }
      if (blobContainer) {
        lines.push(`${t("runtime.blobContainer")}: ${blobContainer}`);
      }
      if (blobName) {
        lines.push(`${t("runtime.blobName")}: ${blobName}`);
      }
      if (lastBlobError?.code || lastBlobError?.message) {
        const errorCode = lastBlobError.code || "UnknownError";
        const errorMessage = lastBlobError.message || "Unknown error";
        lines.push(`${t("runtime.lastBlobError")}: ${errorCode} - ${errorMessage}`);
      }

      runtimeInfo.textContent = lines.join("\n");
      renderSummaryCards();
    }

    async function applyCaddyAndSave() {
      try {
        const next = JSON.parse(configArea.value);
        next.server = next.server || {};
        next.server.caddy = buildCaddyConfigFromForm();
        configArea.value = JSON.stringify(next, null, 2);
        await saveConfig();
        caddyMsg.textContent = t("caddy.msg.saved");
        await loadCaddyStatus();
      } catch {
        caddyMsg.textContent = t("caddy.msg.invalid");
      }
    }

    async function applyCompressionToConfig() {
      try {
        if (isConfigDirty() && !window.confirm(t("compress.apply.confirm"))) {
          return;
        }
        const next = JSON.parse(configArea.value);
        next.server = next.server || {};
        const preset = compressionPresets[compressPreset.value] || compressionPresets.standard;
        next.server.imageCompression = {
          enabled: !!compressEnabled.checked,
          maxSize: preset.maxSize,
          quality: preset.quality,
          format: "jpeg"
        };
        configArea.value = JSON.stringify(next, null, 2);
        await saveConfig();
        compressStats.textContent = t("compress.apply.ok");
      } catch {
        compressStats.textContent = t("compress.apply.invalid");
      }
    }

    async function loadCaddyStatus() {
      const json = await getCaddyStatusApi();
      if (!json.ok) return;
      const status = json.status || {};
      latestCaddyStatus = status;
      const stateKey = `caddy.state.${status.state || "disabled"}`;
      caddyState.textContent = t(stateKey);
      caddyStateMsg.textContent = status.message || "";
      caddyLastWrite.textContent = status.lastWriteAt || "";
      caddyLastReload.textContent = status.lastReloadAt || "";
      caddyLastError.textContent = status.lastError || "";
      renderSummaryCards();
      return status;
    }

    async function restartService() {
      caddyMsg.textContent = t("caddy.state.restart-requested");
      await restartServiceApi();
      startCaddyStatusPolling();
    }

    function startCaddyStatusPolling() {
      const start = Date.now();
      const interval = setInterval(async () => {
        const status = await loadCaddyStatus();
        const state = status?.state;
        if (state === "running" || state === "error") {
          clearInterval(interval);
          return;
        }
        if (Date.now() - start > 60000) {
          clearInterval(interval);
        }
      }, 2000);
    }

    async function verifyAad() {
      verifyMsg.textContent = t("msg.verifyPending");
      const json = await verifyAadApi();
      if (json.ok) {
        const detail = json.preview || json.tokenPreview || "";
        verifyMsg.textContent = t("msg.verifyOk") + detail;
        aadStatus = {
          state: "ok",
          detail,
          checkedAt: new Date().toISOString()
        };
      } else {
        verifyMsg.textContent = t("msg.verifyFail") + (json.error || "Unknown");
        aadStatus = {
          state: "failed",
          detail: json.error || "Unknown",
          checkedAt: new Date().toISOString()
        };
      }
      renderSummaryCards();
    }

    function renderStats(stats) {
      statTotals.innerHTML = "";
      const totals = stats.totals || {};
      const items = [
        { label: t("table.requests"), value: totals.requests || 0 },
        { label: t("table.errors"), value: totals.errors || 0 },
        { label: t("table.promptTokens"), value: totals.promptTokens || 0 },
        { label: t("table.cachedTokens"), value: totals.cachedTokens || 0 },
        { label: t("table.completionTokens"), value: totals.completionTokens || 0 },
        { label: t("table.totalTokens"), value: totals.totalTokens || 0 }
      ];
      items.forEach((item) => {
        const div = document.createElement("div");
        div.className = "stat";
        div.innerHTML = `<span class="muted">${item.label}</span><strong>${item.value}</strong>`;
        statTotals.appendChild(div);
      });
      statTimestamp.textContent = `${t("msg.startedAt")}${stats.startedAt}`;

      modelRows.innerHTML = "";
      const perModel = stats.perModel || {};
      Object.entries(perModel).forEach(([model, s]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${model}</td>
          <td>${s.requests || 0}</td>
          <td>${s.errors || 0}</td>
          <td>${s.promptTokens || 0}</td>
          <td>${s.cachedTokens || 0}</td>
          <td>${s.completionTokens || 0}</td>
          <td>${s.totalTokens || 0}</td>
        `;
        modelRows.appendChild(tr);
      });
    }

    async function loadStats() {
      const json = await getStatsApi();
      latestStats = json;
      renderStats(json);
      renderSummaryCards();
    }

    function collectLogLevels() {
      const levels = [];
      if (logLevelWarn.checked) levels.push("warn");
      if (logLevelError.checked) levels.push("error");
      if (logLevelInfo.checked) levels.push("info");
      return levels;
    }

    function getLogFilters() {
      return {
        level: collectLogLevels(),
        event: logEventInput.value.trim(),
        modelId: logModelInput.value.trim(),
        requestId: logRequestIdInput.value.trim(),
        keyword: logKeywordInput.value.trim(),
        limit: Number(logLimitSelect.value || 100)
      };
    }

    function formatLogTimestamp(value) {
      const parsed = Date.parse(value || "");
      if (Number.isNaN(parsed)) return value || "";
      return new Date(parsed).toLocaleString();
    }

    function renderLogMetaItem(label, value) {
      const span = document.createElement("span");
      span.textContent = `${label}: ${value}`;
      return span;
    }

    function getEventLabel(eventName) {
      if (!eventName) return "";
      const key = `logs.event.${eventName}`;
      const localized = t(key);
      return localized === key ? eventName : localized;
    }

    async function copyLogSummary(entry) {
      const summary = [
        `[${entry.level || "info"}] ${entry.event || ""}`.trim(),
        entry.message || "",
        entry.requestId ? `${t("logs.meta.requestId")}: ${entry.requestId}` : "",
        entry.modelId ? `${t("logs.meta.model")}: ${entry.modelId}` : "",
        entry.errorCode ? `${t("logs.meta.errorCode")}: ${entry.errorCode}` : "",
        entry.status != null ? `${t("logs.meta.status")}: ${entry.status}` : ""
      ].filter(Boolean).join("\n");
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary);
      }
    }

    function applyRequestIdFilter(requestId) {
      if (!requestId) return;
      logRequestIdInput.value = requestId;
      loadLogs();
    }

    function renderLogs(result) {
      logList.innerHTML = "";
      const items = Array.isArray(result?.items) ? result.items : [];
      logSummary.textContent = `${t("logs.summary")}: ${result?.total || 0}`;

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = t("logs.empty");
        logList.appendChild(empty);
        return;
      }

      items.forEach((entry) => {
        const article = document.createElement("article");
        article.className = `log-entry ${entry.level || "info"}`;

        const header = document.createElement("div");
        header.className = "log-header";

        const badges = document.createElement("div");
        badges.className = "log-badges";

        const levelBadge = document.createElement("span");
        levelBadge.className = `badge ${entry.level || "info"}`;
        levelBadge.textContent = String(entry.level || "info");
        badges.appendChild(levelBadge);

        if (entry.event) {
          const eventBadge = document.createElement("span");
          eventBadge.className = "badge";
          eventBadge.textContent = getEventLabel(entry.event);
          badges.appendChild(eventBadge);
        }

        if (entry.status != null) {
          const statusBadge = document.createElement("span");
          statusBadge.className = "badge";
          statusBadge.textContent = `${t("logs.meta.status")} ${entry.status}`;
          badges.appendChild(statusBadge);
        }

        if (entry.errorCode) {
          const errorCodeBadge = document.createElement("span");
          errorCodeBadge.className = "badge";
          errorCodeBadge.textContent = entry.errorCode;
          badges.appendChild(errorCodeBadge);
        }

        const ts = document.createElement("span");
        ts.className = "muted";
        ts.textContent = formatLogTimestamp(entry.ts);

        header.appendChild(badges);
        header.appendChild(ts);
        article.appendChild(header);

        const topLine = document.createElement("div");
        topLine.className = "log-topline";
        if (entry.event) {
          const eventLabel = document.createElement("span");
          eventLabel.className = "event-label";
          eventLabel.textContent = getEventLabel(entry.event);
          topLine.appendChild(eventLabel);
        }
        article.appendChild(topLine);

        const message = document.createElement("div");
        message.className = "log-message";
        message.textContent = entry.message || entry.errorCode || entry.event || "-";
        article.appendChild(message);

        const meta = document.createElement("div");
        meta.className = "log-meta";
        if (entry.requestId) meta.appendChild(renderLogMetaItem(t("logs.meta.requestId"), entry.requestId));
        if (entry.modelId) meta.appendChild(renderLogMetaItem(t("logs.meta.model"), entry.modelId));
        if (entry.routeKey || entry.backendRouteKey) {
          const routeText = entry.backendRouteKey && entry.backendRouteKey !== entry.routeKey
            ? `${entry.routeKey || "-"} -> ${entry.backendRouteKey}`
            : entry.routeKey || entry.backendRouteKey;
          meta.appendChild(renderLogMetaItem(t("logs.meta.route"), routeText));
        }
        if (entry.status != null) meta.appendChild(renderLogMetaItem(t("logs.meta.status"), entry.status));
        if (entry.errorCode) meta.appendChild(renderLogMetaItem(t("logs.meta.errorCode"), entry.errorCode));
        if (entry.latencyMs != null) meta.appendChild(renderLogMetaItem(t("logs.meta.latency"), `${entry.latencyMs} ms`));
        if (meta.childNodes.length > 0) {
          article.appendChild(meta);
        }

        const actions = document.createElement("div");
        actions.className = "log-actions";
        if (entry.requestId) {
          const filterBtn = document.createElement("button");
          filterBtn.className = "mini-btn";
          filterBtn.textContent = t("logs.filterByRequest");
          filterBtn.onclick = () => applyRequestIdFilter(entry.requestId);
          actions.appendChild(filterBtn);
        }
        const copyBtn = document.createElement("button");
        copyBtn.className = "mini-btn";
        copyBtn.textContent = t("logs.copySummary");
        copyBtn.onclick = () => {
          copyLogSummary(entry);
        };
        actions.appendChild(copyBtn);
        article.appendChild(actions);

        if (entry.fields && Object.keys(entry.fields).length > 0) {
          const details = document.createElement("details");
          details.className = "log-details";
          details.open = entry.level === "error" || entry.level === "fatal";
          const summary = document.createElement("summary");
          summary.textContent = t("logs.details");
          const pre = document.createElement("pre");
          pre.textContent = JSON.stringify(entry.fields, null, 2);
          details.appendChild(summary);
          details.appendChild(pre);
          article.appendChild(details);
        }

        logList.appendChild(article);
      });
    }

    async function loadLogs() {
      try {
        const json = await getLogsApi(getLogFilters());
        renderLogs(json);
      } catch {
        logSummary.textContent = t("logs.loadFailed");
        logList.innerHTML = "";
      }
    }

    function updateLogsAutoRefresh() {
      if (logsRefreshTimer) {
        clearInterval(logsRefreshTimer);
        logsRefreshTimer = null;
      }
      const logAutoRefreshHint = document.getElementById("logAutoRefreshHint");
      if (logAutoRefreshHint) {
        logAutoRefreshHint.textContent = logAutoRefresh.checked
          ? t("logs.autoRefreshHint.on")
          : t("logs.autoRefreshHint.off");
      }
      if (!logAutoRefresh.checked) return;
      logsRefreshTimer = setInterval(() => {
        loadLogs();
      }, 5000);
    }

    async function sendRequest() {
      responseArea.textContent = t("msg.requesting");
      const endpoint = document.getElementById("endpointSelect").value;
      let payload;
      try {
        payload = JSON.parse(payloadArea.value);
      } catch {
        responseArea.textContent = t("msg.invalidPayload");
        return;
      }
      payload = await maybeInjectImageFromFile(payload);
      if (compressEnabled.checked && !imageFileInput.files?.length) {
        payload = await compressPayloadImages(payload);
      }
      if (!compressEnabled.checked) {
        compressStats.textContent = "";
      }
      updatePayloadAreaSafely(payload);
      const apiKey = document.getElementById("apiKeyInput").value;
      const res = await sendProxyRequestApi(endpoint, payload, apiKey);
      if (payload.stream) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
          responseArea.textContent = text;
        }
        return;
      }
      const json = await res.json().catch(() => ({}));
      responseArea.textContent = JSON.stringify(json, null, 2);
    }

    document.getElementById("loadBtn").onclick = loadConfig;
    document.getElementById("saveBtn").onclick = saveConfig;
    document.getElementById("reloadBtn").onclick = reloadConfig;
    document.getElementById("verifyBtn").onclick = verifyAad;
    document.getElementById("sendBtn").onclick = sendRequest;
    document.getElementById("refreshStatsBtn").onclick = loadStats;
    document.getElementById("refreshLogsBtn").onclick = loadLogs;
    document.getElementById("applyCaddyBtn").onclick = applyCaddyAndSave;
    document.getElementById("refreshCaddyBtn").onclick = loadConfig;
    document.getElementById("restartServiceBtn").onclick = restartService;
    document.getElementById("insertDataUrlBtn").onclick = () => insertPlaceholder("__IMAGE_DATA_URL__");
    document.getElementById("insertBase64Btn").onclick = () => insertPlaceholder("__IMAGE_BASE64__");
    applyCompressConfigBtn.onclick = applyCompressionToConfig;
    imageFileInput.onchange = () => {
      const file = imageFileInput.files?.[0];
      imageFileInfo.textContent = file
        ? `${t("compress.file.selected")}: ${file.name} (${formatBytes(file.size)})`
        : t("compress.file.none");
    };
    document.getElementById("langZh").onclick = () => {
      setLanguage("zh-CN");
      renderConfigMessage();
      updateConfigEditorState();
      renderSummaryCards();
      resetPayloadSample();
      loadStats();
      loadLogs();
      updateLogsAutoRefresh();
      loadCaddyStatus();
      loadRuntimeInfo();
      renderCaddyPreview();
    };
    document.getElementById("langEn").onclick = () => {
      setLanguage("en");
      renderConfigMessage();
      updateConfigEditorState();
      renderSummaryCards();
      resetPayloadSample();
      loadStats();
      loadLogs();
      updateLogsAutoRefresh();
      loadCaddyStatus();
      loadRuntimeInfo();
      renderCaddyPreview();
    };
    [
      caddyEnabled,
      caddyDomain,
      caddyEmail,
      caddyHttpsPort,
      caddyUpstreamHost,
      caddyUpstreamPort,
      caddyDialTimeoutMs,
      caddyResponseHeaderTimeoutMs,
      caddyKeepAliveTimeoutMs
    ].forEach((el) => {
      el.addEventListener("input", renderCaddyPreview);
      el.addEventListener("change", renderCaddyPreview);
    });
    [logLevelWarn, logLevelError, logLevelInfo, logEventInput, logModelInput, logRequestIdInput, logKeywordInput, logLimitSelect].forEach((el) => {
      el.addEventListener("change", loadLogs);
    });
    [logEventInput, logModelInput, logRequestIdInput, logKeywordInput].forEach((el) => {
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          loadLogs();
        }
      });
    });
    logAutoRefresh.addEventListener("change", updateLogsAutoRefresh);
    configArea.addEventListener("input", updateConfigEditorState);

    setLanguage(getStoredLang());
    renderSummaryCards();
    resetPayloadSample();
    loadConfig();
    loadStats();
    loadLogs();
    updateLogsAutoRefresh();
    loadCaddyStatus();
    loadRuntimeInfo();
