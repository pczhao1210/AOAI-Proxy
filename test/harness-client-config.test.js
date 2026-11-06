import assert from "node:assert/strict";
import test from "node:test";
import { buildHarnessClientConfig } from "../admin-ui/src/harness-client-config.js";

test("Harness client snippets normalize root and /v1 addresses without discovering credentials", () => {
  for (const address of ["https://proxy.example.com", "https://proxy.example.com/v1", "https://proxy.example.com/v1/"]) {
    const codex = buildHarnessClientConfig("codex", address, "public-model", "/control");
    assert.match(codex.toml, /base_url = "https:\/\/proxy\.example\.com\/v1"/);
    assert.match(codex.toml, /wire_api = "responses"/);
    assert.match(codex.toml, /supports_websockets = false/);
    assert.match(codex.toml, /env_key = "AOAI_PROXY_API_KEY"/);
    assert.match(codex.shell, /YOUR_PROXY_API_KEY/);
    const claude = buildHarnessClientConfig("claudeCode", address, "public-model");
    assert.match(claude.shell, /ANTHROPIC_BASE_URL='https:\/\/proxy\.example\.com'/);
    assert.match(claude.shell, /CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1/);
    assert.match(claude.shell, /claude --model 'public-model'/);
  }
  assert.match(buildHarnessClientConfig("codex", "https://proxy.example.com/gateway/v1", "alias").toml, /gateway\/v1"/);
});

test("Harness snippets reject missing models, invalid addresses and admin/credential URLs explicitly", () => {
  for (const address of ["file:///tmp/test", "not-a-url", "https://user:pass@proxy.example.com", "https://proxy.example.com?key=secret", "https://proxy.example.com/#fragment", "https://proxy.exa\nmple.com"]) {
    assert.equal(buildHarnessClientConfig("codex", address, "model").error, "invalidAddress");
  }
  assert.equal(buildHarnessClientConfig("codex", "", "model").error, "addressRequired");
  assert.equal(buildHarnessClientConfig("codex", "https://proxy.example.com", "").error, "modelRequired");
  assert.equal(buildHarnessClientConfig("codex", "https://proxy.example.com/control/", "model", "/control").error, "adminAddress");
  assert.equal(buildHarnessClientConfig("codex", "https://proxy.example.com/admin/api", "model").error, "adminAddress");
});

test("Harness snippets quote model IDs as data in TOML and shell examples", () => {
  const id = "team's \"model\"\\alias\nnext";
  const codex = buildHarnessClientConfig("codex", "https://proxy.example.com", id);
  assert.equal(JSON.parse(codex.toml.split("\n")[0].slice("model = ".length)), id);
  const claude = buildHarnessClientConfig("claudeCode", "https://proxy.example.com", "team's model");
  assert.ok(claude.shell.endsWith("claude --model 'team'\\''s model'"));
});
