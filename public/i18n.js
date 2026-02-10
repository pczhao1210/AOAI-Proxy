(function () {
  const dictionaries = {
    "zh-CN": {
      "app.title": "AOAI Foundry Proxy Admin",
      "app.subtitle": "配置代理、验证 AAD、查看模型调用统计与测试 OpenAI 兼容端点",
      "lang.zh": "中文",
      "lang.en": "English",

      "section.config.title": "配置管理",
      "section.config.desc": "编辑 JSON 配置并保存，或重载磁盘配置。",
      "btn.load": "加载",
      "btn.save": "保存",
      "btn.reload": "重载",

      "section.aad.title": "AAD 验证",
      "section.aad.desc": "验证服务主体或系统分配身份是否可获取 Bearer Token。",
      "btn.verifyAad": "验证 AAD",

      "section.stats.title": "统计总览",
      "btn.refreshStats": "刷新统计",

      "section.caddy.title": "域名与 TLS（Caddy）",
      "section.caddy.desc": "配置独立 Caddy 进程的域名与证书邮箱，并生成 Caddyfile。",
      "caddy.enable": "启用 Caddyfile 生成",
      "caddy.domain": "域名",
      "caddy.email": "证书邮箱",
      "caddy.httpsPort": "TLS 入口端口",
      "caddy.upstreamHost": "上游地址",
      "caddy.upstreamPort": "上游端口",
      "btn.caddy.apply": "应用并保存",
      "btn.caddy.refresh": "从配置加载",
      "btn.caddy.restart": "重启服务",
      "caddy.preview.disabled": "Caddyfile 未启用生成",
      "caddy.msg.saved": "已保存并尝试热重载 Caddy",
      "caddy.msg.invalid": "应用失败: JSON 无效",
      "caddy.status.title": "Caddy 状态",
      "caddy.status.state": "状态",
      "caddy.status.message": "信息",
      "caddy.status.lastWrite": "Caddyfile 更新时间",
      "caddy.status.lastReload": "Reload 时间",
      "caddy.status.lastError": "错误信息",
      "caddy.state.disabled": "未启用",
      "caddy.state.configured": "已配置，待生效",
      "caddy.state.running": "正常运行",
      "caddy.state.error": "配置失败",
      "caddy.state.restart-needed": "配置完成待重启",
      "caddy.state.restart-requested": "正在重启",

      "section.models.title": "模型统计",
      "table.model": "模型",
      "table.requests": "请求数",
      "table.errors": "错误数",
      "table.promptTokens": "Prompt Tokens",
      "table.completionTokens": "Completion Tokens",
      "table.totalTokens": "Total Tokens",

      "section.test.title": "端点测试",
      "section.test.desc": "选择端点并输入 JSON 请求体，使用 API Key 调用代理。",
      "placeholder.apiKey": "API Key",
      "btn.send": "发送请求",
      "compress.enable": "启用图片压缩",
      "compress.preset": "压缩预设",
      "compress.preset.light": "轻度（1600px / 0.85）",
      "compress.preset.standard": "标准（1280px / 0.8）",
      "compress.preset.strong": "强力（1024px / 0.7）",
      "compress.stats": "压缩结果",
      "compress.stats.none": "未检测到可压缩图片",
      "compress.note": "仅处理 data:image/* URL 或 image_base64 字段",
      "compress.placeholder.note": "使用占位符避免粘贴超大 base64",
      "compress.placeholder.dataUrl": "插入 __IMAGE_DATA_URL__",
      "compress.placeholder.base64": "插入 __IMAGE_BASE64__",
      "compress.file.label": "图片文件",
      "compress.file.none": "未选择图片文件",
      "compress.file.selected": "已选择",
      "compress.placeholder.missing": "未找到占位符，未替换",
      "payload.tooLarge": "请求体过大，已跳过回写到文本框",
      "compress.apply": "应用到配置并保存",
      "compress.apply.ok": "已写入配置并保存",
      "compress.apply.invalid": "写入失败: JSON 无效",
      "compress.apply.confirm": "检测到配置未保存修改，仍要覆盖 imageCompression 并保存吗？",

      "msg.loaded": "已加载",
      "msg.saved": "保存成功",
      "msg.saveFailed": "保存失败",
      "msg.reloadSuccess": "重载成功",
      "msg.reloadFailed": "重载失败",
      "msg.invalidJson": "JSON 无效",
      "msg.verifyPending": "验证中...",
      "msg.verifyOk": "验证成功: ",
      "msg.verifyFail": "验证失败: ",
      "msg.requesting": "请求中...",
      "msg.invalidPayload": "请求体 JSON 无效",
      "msg.startedAt": "开始于: ",

      "payload.greeting": "你好"
    },
    "en": {
      "app.title": "AOAI Foundry Proxy Admin",
      "app.subtitle": "Configure proxy, verify AAD, view model stats, and test OpenAI-compatible endpoints",
      "lang.zh": "中文",
      "lang.en": "English",

      "section.config.title": "Configuration",
      "section.config.desc": "Edit JSON config and save, or reload from disk.",
      "btn.load": "Load",
      "btn.save": "Save",
      "btn.reload": "Reload",

      "section.aad.title": "AAD Verification",
      "section.aad.desc": "Verify service principal or managed identity token acquisition.",
      "btn.verifyAad": "Verify AAD",

      "section.stats.title": "Statistics",
      "btn.refreshStats": "Refresh",

      "section.caddy.title": "Domain & TLS (Caddy)",
      "section.caddy.desc": "Configure domain and certificate email for Caddy and generate Caddyfile.",
      "caddy.enable": "Enable Caddyfile generation",
      "caddy.domain": "Domain",
      "caddy.email": "Certificate Email",
      "caddy.httpsPort": "TLS Port",
      "caddy.upstreamHost": "Upstream Host",
      "caddy.upstreamPort": "Upstream Port",
      "btn.caddy.apply": "Apply & Save",
      "btn.caddy.refresh": "Load from Config",
      "btn.caddy.restart": "Restart Service",
      "caddy.preview.disabled": "Caddyfile generation disabled",
      "caddy.msg.saved": "Saved and attempted Caddy reload",
      "caddy.msg.invalid": "Apply failed: invalid JSON",
      "caddy.status.title": "Caddy Status",
      "caddy.status.state": "State",
      "caddy.status.message": "Message",
      "caddy.status.lastWrite": "Caddyfile Updated",
      "caddy.status.lastReload": "Reload Time",
      "caddy.status.lastError": "Error",
      "caddy.state.disabled": "Disabled",
      "caddy.state.configured": "Configured (pending)",
      "caddy.state.running": "Running",
      "caddy.state.error": "Failed",
      "caddy.state.restart-needed": "Restart required",
      "caddy.state.restart-requested": "Restarting",

      "section.models.title": "Model Stats",
      "table.model": "Model",
      "table.requests": "Requests",
      "table.errors": "Errors",
      "table.promptTokens": "Prompt Tokens",
      "table.completionTokens": "Completion Tokens",
      "table.totalTokens": "Total Tokens",

      "section.test.title": "Endpoint Test",
      "section.test.desc": "Choose an endpoint and send JSON payload using an API key.",
      "placeholder.apiKey": "API Key",
      "btn.send": "Send",
      "compress.enable": "Enable image compression",
      "compress.preset": "Compression Preset",
      "compress.preset.light": "Light (1600px / 0.85)",
      "compress.preset.standard": "Standard (1280px / 0.8)",
      "compress.preset.strong": "Strong (1024px / 0.7)",
      "compress.stats": "Compression result",
      "compress.stats.none": "No compressible images found",
      "compress.note": "Only handles data:image/* URLs or image_base64 fields",
      "compress.placeholder.note": "Use placeholders to avoid pasting huge base64",
      "compress.placeholder.dataUrl": "Insert __IMAGE_DATA_URL__",
      "compress.placeholder.base64": "Insert __IMAGE_BASE64__",
      "compress.file.label": "Image file",
      "compress.file.none": "No image selected",
      "compress.file.selected": "Selected",
      "compress.placeholder.missing": "No placeholder found; not replaced",
      "payload.tooLarge": "Payload too large; skipped writing back to textarea",
      "compress.apply": "Apply to config and save",
      "compress.apply.ok": "Applied and saved",
      "compress.apply.invalid": "Apply failed: invalid JSON",
      "compress.apply.confirm": "Unsaved changes detected. Overwrite imageCompression and save?",

      "msg.loaded": "Loaded",
      "msg.saved": "Saved",
      "msg.saveFailed": "Save failed",
      "msg.reloadSuccess": "Reloaded",
      "msg.reloadFailed": "Reload failed",
      "msg.invalidJson": "Invalid JSON",
      "msg.verifyPending": "Verifying...",
      "msg.verifyOk": "Verified: ",
      "msg.verifyFail": "Verification failed: ",
      "msg.requesting": "Requesting...",
      "msg.invalidPayload": "Invalid JSON payload",
      "msg.startedAt": "Started at: ",

      "payload.greeting": "Hello"
    }
  };

  const DEFAULT_LANG = "zh-CN";

  function getStoredLang() {
    return localStorage.getItem("lang") || DEFAULT_LANG;
  }

  function setLanguage(lang) {
    const next = dictionaries[lang] ? lang : DEFAULT_LANG;
    localStorage.setItem("lang", next);
    document.documentElement.lang = next;
    applyI18n(next);
  }

  function t(key, lang) {
    const l = lang || getStoredLang();
    return dictionaries[l]?.[key] || dictionaries[DEFAULT_LANG]?.[key] || key;
  }

  function applyI18n(lang) {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = t(key, lang);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (key) el.setAttribute("placeholder", t(key, lang));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.setAttribute("title", t(key, lang));
    });
  }

  window.I18N = { setLanguage, t, applyI18n, getStoredLang };
})();
