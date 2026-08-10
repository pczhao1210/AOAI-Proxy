Route smoke tests live here.

Reliability tests cover PostgreSQL pool error handling and server shutdown behavior:

```bash
npm run test:unit
```

Included scripts:

- `test/routes/chat-completion.js`
- `test/routes/response.js`
- `test/routes/openai-image.js`
- `test/routes/blackforest-image.js`

Run the full route batch:

```bash
npm run test:routes
```

The route batch also covers client-specific model discovery, native Messages token counting, native Responses compaction, strict protocol-shim compatibility guards, SSE terminal events, and route-validation gates. Focused contracts can be run by ID:

```bash
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("message-count-tokens")'
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("response-compact")'
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("shim-compatibility-guards")'
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("request-parameter-policy")'
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("native-error-passthrough")'
```

Run one script directly:

```bash
node test/routes/chat-completion.js
node test/routes/blackforest-image.js
```

Each script starts a disposable proxy process with a temporary config and a local mock upstream, then asserts the route and model call both succeed.

Claude Code CLI contract test:

```bash
npm run test:cli:claude-code
```

This test runs the pinned Claude Code `2.1.226` package through `npx`, using an isolated config directory. It verifies native Messages streaming, new beta and SDK metadata forwarding, model mapping, and upstream credential isolation. Set `CLAUDE_CODE_EXPECTED_VERSION` to test another explicitly supported version.

Codex CLI contract test:

```bash
npm run test:cli:codex
```

This test requires Codex `0.147.0` on `PATH` and uses a temporary workspace-local `CODEX_HOME`. It uses command-backed test auth to make `codex debug models` refresh and parse the remote catalog, then uses the production-style `env_key` provider for `codex exec`. It verifies the Responses item lifecycle, terminal event, agent message, and upstream credential isolation. Set `CODEX_EXPECTED_VERSION` to test another explicitly supported version.

On POSIX systems, both CLI scripts terminate the full process group on timeout so package-manager or CLI descendants cannot keep CI pipes open. Windows currently terminates only the direct child process; run these pinned smoke tests in Linux CI when descendant cleanup is required.

Real model scripts:

- `test/routes/real-chat-completion.js`
- `test/routes/real-response.js`
- `test/routes/real-openai-image.js`
- `test/routes/real-blackforest-image.js`

These scripts call a real running proxy and real configured models. Required environment variables:

```bash
export AOAI_PROXY_REAL_BASE_URL=http://127.0.0.1:3000
export AOAI_PROXY_REAL_API_KEY=your-proxy-api-key
export AOAI_PROXY_REAL_CHAT_MODEL=gpt-5-mini
export AOAI_PROXY_REAL_RESPONSE_MODEL=gpt-5.2-codex
export AOAI_PROXY_REAL_OPENAI_IMAGE_MODEL=gpt-image-1.5
export AOAI_PROXY_REAL_BLACKFOREST_IMAGE_MODEL=flux-2-pro
```

Run them with:

```bash
npm run test:real
npm run test:real:chat
npm run test:real:openai-image
```

If an image route returns `b64_json`, the script writes a `.png` file into `test/output` by default. You can override that with `AOAI_PROXY_REAL_OUTPUT_DIR`.

Latency analysis script:

- `test/analyze-first-token-latency.js`

It sends real streaming requests through the proxy with `x-debug-latency: 1`, measures client-side timings for response headers, first chunk, first token, and full completion, and then tries to pull the matching `proxy.request_timing` entry from `/admin/api/logs` by `x-request-id`.

Notes:

- `proxy.request_timing` is disabled for normal traffic by default.
- The proxy only emits that timing log when the request carries `x-debug-latency: 1`.
- `test/analyze-first-token-latency.js` adds that request header automatically, so the script can fetch the timing entry without changing normal production traffic.

Typical environment variables:

```bash
export AOAI_PROXY_LATENCY_BASE_URL=http://127.0.0.1:3000
export AOAI_PROXY_LATENCY_API_KEY=your-proxy-api-key
export AOAI_PROXY_LATENCY_ROUTE=chat/completions
export AOAI_PROXY_LATENCY_MODEL=gpt-5-mini
export AOAI_PROXY_LATENCY_ITERATIONS=3
export AOAI_PROXY_LATENCY_FETCH_PROXY_LOGS=true
```

Optional admin auth for pulling internal timing logs:

```bash
export AOAI_PROXY_LATENCY_ADMIN_USERNAME=admin
export AOAI_PROXY_LATENCY_ADMIN_PASSWORD=change-me
```

Run it with:

```bash
npm run test:latency
```

The script writes a JSON report into `test/output` by default.

If you want to reproduce the behavior manually, make sure your request also carries `x-debug-latency: 1`; otherwise the proxy will not emit `proxy.request_timing` for that request.