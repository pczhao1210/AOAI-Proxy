// Preloaded only by the disposable proxy in the provider integration test.
const originalFetch = globalThis.fetch;
const rejectedRequests = new Set();
const profile = process.env.COPILOT_FIXTURE_PROFILE;
const identity = {
  vscode: { clientId: "Iv1.b507a08c87ecfe98", userAgent: "GitHubCopilotChat/0.38.2", bearer: "Bearer fixture-exchanged-private",
    models: { "editor-version": "vscode/1.110.1", "editor-plugin-version": "copilot-chat/0.38.2",
      "x-github-api-version": "2025-10-01", "copilot-integration-id": "vscode-chat", "openai-intent": undefined },
    inference: { "editor-version": "vscode/1.110.1", "editor-plugin-version": "copilot-chat/0.38.2",
      "x-github-api-version": "2025-10-01", "copilot-integration-id": undefined, "openai-intent": undefined } },
  opencode: { clientId: "Ov23li8tweQw6odWQebz", userAgent: "opencode/1.0.0", bearer: "Bearer fixture-oauth-private",
    models: { "editor-version": undefined, "x-github-api-version": "2026-06-01", "openai-intent": undefined },
    inference: { "editor-version": undefined, "x-github-api-version": "2026-06-01", "openai-intent": "conversation-edits" } }
}[profile];
if (!identity) throw new Error("COPILOT_FIXTURE_PROFILE must be vscode or opencode");
const header = (options, name) => Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
const expectHeaders = (options, expected) => {
  for (const [name, value] of Object.entries({ "user-agent": identity.userAgent, ...expected })) {
    if (header(options, name) !== value) throw new Error(`Unexpected ${name} for ${profile}`);
  }
};
function loginForm(options) {
  expectHeaders(options, { "content-type": profile === "opencode" ? "application/json" : "application/x-www-form-urlencoded" });
  const form = profile === "opencode" ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body));
  if (form.client_id !== identity.clientId) throw new Error(`Unexpected client_id for ${profile}`);
  return form;
}
globalThis.fetch = async (target, options) => {
  const url = new URL(target);
  if (url.hostname === "127.0.0.1") return originalFetch(target, options);
  if (url.origin === "https://github.com") {
    if (url.pathname === "/login/device/code" && loginForm(options).scope === "read:user") return Response.json({
      device_code: "device-fixture-private", user_code: "fixture-user-code", interval: 1,
      expires_in: 60, verification_uri: "https://github.com/login/device"
    });
    if (url.pathname === "/login/oauth/access_token" && loginForm(options).device_code === "device-fixture-private") {
      return Response.json({ access_token: "fixture-oauth-private" });
    }
  }
  if (url.origin === "https://api.github.com") {
    if (url.pathname === "/user") {
      expectHeaders(options, {});
      return Response.json({ id: 21 });
    }
    if (url.pathname === "/copilot_internal/v2/token" && profile === "vscode") {
      expectHeaders(options, { "editor-version": "vscode/1.110.1", "editor-plugin-version": "copilot-chat/0.38.2" });
      return Response.json({ token: "fixture-exchanged-private", expires_at: Math.floor(Date.now() / 1000) + 600 });
    }
  }
  if (url.origin === "https://api.githubcopilot.com") {
    const bearer = options.headers.authorization;
    if (url.pathname === "/models") {
      expectHeaders(options, identity.models);
      return Response.json({ data: [
        { id: "original", supported_endpoints: ["/chat/completions"] }, { id: "not-approved", model_picker_enabled: false }
      ] });
    }
    expectHeaders(options, identity.inference);
    const body = JSON.parse(options.body);
    if (body.messages?.at(-1)?.content === "reject-once") {
      if (rejectedRequests.has(body.stream === true)) throw new Error("Rejected credential replay");
      rejectedRequests.add(body.stream === true);
      return Response.json({ error: { message: "Authorization expired" } }, { status: 401 });
    }
    if (url.pathname === "/chat/completions" && body.model === "original" && bearer === identity.bearer) {
      if (body.stream) {
        const chunk = { id: "fixture-stream", object: "chat.completion.chunk", model: "original",
          choices: [{ index: 0, delta: { content: "isolated" }, finish_reason: null }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({
          ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "from-copilot-fixture", object: "chat.completion", model: "original",
        choices: [{ index: 0, message: { role: "assistant", content: "isolated" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } });
    }
  }
  throw new Error("Unmatched offline fixture request");
};
