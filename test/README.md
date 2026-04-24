Route smoke tests live here.

Included scripts:

- `test/routes/chat-completion.js`
- `test/routes/response.js`
- `test/routes/openai-image.js`
- `test/routes/blackforest-image.js`

Run all four:

```bash
npm run test:routes
```

Run one script directly:

```bash
node test/routes/chat-completion.js
node test/routes/blackforest-image.js
```

Each script starts a disposable proxy process with a temporary config and a local mock upstream, then asserts the route and model call both succeed.

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

It sends real streaming requests through the proxy, measures client-side timings for response headers, first chunk, first token, and full completion, and then tries to pull the matching `proxy.request_timing` entry from `/admin/api/logs` by `x-request-id`.

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