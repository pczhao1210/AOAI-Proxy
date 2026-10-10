import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

test("native text JSON/SSE never follow same-origin or cross-origin upstream redirects", async (t) => {
  const unexpectedRequests = [];
  const sink = http.createServer((req, res) => {
    unexpectedRequests.push(req.headers);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[]}');
  });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  let status = 307;
  let sameOrigin = false;
  try {
    await withTestContext(async (ctx) => {
      for (const redirectStatus of [301, 302, 303, 307, 308]) {
        status = redirectStatus;
        for (const origin of ["same", "different"]) {
          sameOrigin = origin === "same";
          for (const [route, model, input] of [
            ["chat/completions", "gpt-5-mini", { messages: [{ role: "user", content: "private prompt" }] }],
            ["responses", "gpt-5.6-luna", { input: "private prompt" }],
            ["messages", "claude-native", { max_tokens: 16, messages: [{ role: "user", content: "private prompt" }] }]
          ]) {
            for (const stream of [false, true]) await t.test(`${route} native ${stream ? "SSE" : "JSON"}: ${status} ${origin} origin`, async () => {
              ctx.clearUpstreamRequests();
              const result = await ctx.publicRequest(`/v1/${route}`, {
                method: "POST", json: { model, ...input, stream }
              });
              assert.equal(result.status, 502, result.text);
              assert.equal(result.json.error.code, "UPSTREAM_REDIRECT_NOT_ALLOWED");
              assert.equal(result.headers.get("location"), null);
              assert.equal(ctx.upstreamRequests.length, 1, "Must not replay the request at a redirect target");
              const request = ctx.upstreamRequests[0];
              assert.ok(request.url.includes(route));
              assert.equal(request.body.stream, stream);
              assert.equal(request.headers[route === "messages" ? "x-api-key" : "api-key"], "test-upstream-key");
              assert.equal(unexpectedRequests.length, 0, "Neither credentials nor body may reach another origin");
            });
          }
        }
      }
    }, { upstreamHandler({ req, res }) {
      if (req.url.startsWith("/redirect-target")) {
        unexpectedRequests.push(req.headers);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"choices":[]}');
      } else {
        res.writeHead(status, { location: sameOrigin ? "/redirect-target" : `http://127.0.0.1:${sink.address().port}/redirect-target` });
        res.end("redirect");
      }
      return true;
    } });
  } finally { await new Promise(resolve => sink.close(resolve)); }
});
