import {
  getConfigApi,
  saveConfigApi,
  reloadConfigApi,
  verifyAadApi,
  getStatsApi,
  getCaddyStatusApi,
  restartServiceApi,
  sendProxyRequestApi
} from "./api.js";

    const { setLanguage, t, getStoredLang, applyI18n } = window.I18N;
    const configArea = document.getElementById("configArea");
    const configMsg = document.getElementById("configMsg");
    const verifyMsg = document.getElementById("verifyMsg");
    const statTotals = document.getElementById("statTotals");
    const statTimestamp = document.getElementById("statTimestamp");
    const modelRows = document.getElementById("modelRows");
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
    const caddyPreview = document.getElementById("caddyPreview");
    const caddyMsg = document.getElementById("caddyMsg");
    const caddyState = document.getElementById("caddyState");
    const caddyStateMsg = document.getElementById("caddyStateMsg");
    const caddyLastWrite = document.getElementById("caddyLastWrite");
    const caddyLastReload = document.getElementById("caddyLastReload");
    const caddyLastError = document.getElementById("caddyLastError");
    let configMsgState = null;

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
      setLoadedConfigText();
    }

    async function saveConfig() {
      try {
        const next = JSON.parse(configArea.value);
        const json = await saveConfigApi(next);
        if (json.ok) {
          setConfigMessageState({ kind: "key", key: "msg.saved" });
          configArea.value = JSON.stringify(json.config, null, 2);
          hydrateCaddyForm(json.config);
          hydrateCompressionFromConfig(json.config);
          setLoadedConfigText();
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
        setLoadedConfigText();
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
        upstreamPort: Number(caddyUpstreamPort.value || 3000)
      };
    }

    function renderCaddyPreview() {
      const cfg = buildCaddyConfigFromForm();
      if (!cfg.enabled) {
        caddyPreview.textContent = t("caddy.preview.disabled");
        return;
      }
      const hostPort = `${cfg.domain}:${cfg.httpsPort}`;
      const upstream = `${cfg.upstreamHost}:${cfg.upstreamPort}`;
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
      dial_timeout 5s
      response_header_timeout 120s
      keepalive 120s
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
      renderCaddyPreview();
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
      const stateKey = `caddy.state.${status.state || "disabled"}`;
      caddyState.textContent = t(stateKey);
      caddyStateMsg.textContent = status.message || "";
      caddyLastWrite.textContent = status.lastWriteAt || "";
      caddyLastReload.textContent = status.lastReloadAt || "";
      caddyLastError.textContent = status.lastError || "";
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
        verifyMsg.textContent = t("msg.verifyOk") + json.tokenPreview;
      } else {
        verifyMsg.textContent = t("msg.verifyFail") + (json.error || "Unknown");
      }
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
      renderStats(json);
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
      resetPayloadSample();
      loadStats();
      loadCaddyStatus();
      renderCaddyPreview();
    };
    document.getElementById("langEn").onclick = () => {
      setLanguage("en");
      renderConfigMessage();
      resetPayloadSample();
      loadStats();
      loadCaddyStatus();
      renderCaddyPreview();
    };
    [caddyEnabled, caddyDomain, caddyEmail, caddyHttpsPort, caddyUpstreamHost, caddyUpstreamPort].forEach((el) => {
      el.addEventListener("input", renderCaddyPreview);
      el.addEventListener("change", renderCaddyPreview);
    });

    setLanguage(getStoredLang());
    resetPayloadSample();
    loadConfig();
    loadStats();
    loadCaddyStatus();
