function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

export function buildHarnessClientConfig(client, address, modelId, adminPath = "/admin") {
  if (!["claudeCode", "codex"].includes(client)) throw new Error(`Unknown Harness client: ${client}`);
  if (!address.trim()) return { error: "addressRequired" };
  let url;
  try {
    url = new URL(address.trim());
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { error: "invalidAddress" };
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /[\s\u0000-\u001f\u007f]/.test(address.trim())) return { error: "invalidAddress" };
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  const managementPath = adminPath.replace(/\/+$/, "") || "/admin";
  if (pathname === managementPath || pathname.startsWith(`${managementPath}/`)) return { error: "adminAddress" };
  if (!modelId) return { error: "modelRequired" };
  const root = `${url.origin}${pathname}`;
  if (client === "claudeCode") {
    return { shell: [
      `export ANTHROPIC_BASE_URL=${shellQuote(root)}`,
      "export ANTHROPIC_AUTH_TOKEN='YOUR_PROXY_API_KEY'",
      "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
      `claude --model ${shellQuote(modelId)}`
    ].join("\n") };
  }
  return {
    shell: "export AOAI_PROXY_API_KEY='YOUR_PROXY_API_KEY'\ncodex",
    toml: [
      `model = ${tomlString(modelId)}`,
      'model_provider = "aoai_proxy"',
      "",
      "[model_providers.aoai_proxy]",
      'name = "AOAI Proxy"',
      `base_url = ${tomlString(`${root}/v1`)}`,
      'env_key = "AOAI_PROXY_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false"
    ].join("\n")
  };
}
