// Preloaded only by the disposable proxy in the provider integration test.
const originalFetch = globalThis.fetch;
const rejectedRequests = new Set();
globalThis.fetch = async (target, options) => {
  const url = new URL(target);
  if (url.hostname === "127.0.0.1") return originalFetch(target, options);
  if (url.origin === "https://github.com") {
    if (url.pathname === "/login/device/code") return Response.json({
      device_code: "device-fixture-private", user_code: "fixture-user-code", interval: 1,
      expires_in: 60, verification_uri: "https://github.com/login/device"
    });
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "fixture-oauth-private" });
  }
  if (url.origin === "https://api.github.com") {
    if (url.pathname === "/user") return Response.json({ id: 21 });
    if (url.pathname === "/copilot_internal/v2/token") return Response.json({
      token: "fixture-exchanged-private", expires_at: Math.floor(Date.now() / 1000) + 600
    });
  }
  if (url.origin === "https://api.githubcopilot.com") {
    const bearer = options.headers.authorization;
    if (url.pathname === "/models") return Response.json({ data: [
      { id: "original", supported_endpoints: ["/chat/completions"] }, { id: "not-approved", model_picker_enabled: false }
    ] });
    const body = JSON.parse(options.body);
    if (body.messages?.at(-1)?.content === "reject-once") {
      if (rejectedRequests.has(body.stream === true)) throw new Error("Rejected credential replay");
      rejectedRequests.add(body.stream === true);
      return Response.json({ error: { message: "Authorization expired" } }, { status: 401 });
    }
    if (url.pathname === "/chat/completions" && body.model === "original" &&
      bearer === `Bearer ${process.env.COPILOT_OPENCODE_CLIENT_ID ? "fixture-oauth-private" : "fixture-exchanged-private"}`
      && !Object.keys(options.headers).some(key => /editor-version|integration-id/i.test(key))) {
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
