import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { streamPassthrough, streamShim } from "../src/proxy/stream.js";

class StalledReply extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  output = "";

  write(value) {
    this.output += String(value);
    return false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

const EVENTS = {
  "chat/completions": { choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
  responses: { type: "response.output_text.delta", item_id: "message-1", output_index: 0, content_index: 0, delta: "hello" },
  messages: { type: "message_start", message: { id: "message-1", model: "test-model", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }
};

for (const routeKey of Object.keys(EVENTS)) {
  for (const backendRouteKey of Object.keys(EVENTS)) {
    test(`${routeKey} via ${backendRouteKey}: stream timeouts release stalled downstream writes`, async (context) => {
      for (const timeout of [
        { policy: { idleTimeoutMs: 20, maxStreamDurationMs: 0 }, code: "UPSTREAM_IDLE_TIMEOUT", reason: "idle-timeout" },
        { policy: { idleTimeoutMs: 1000, maxStreamDurationMs: 20 }, code: "UPSTREAM_MAX_STREAM_DURATION", reason: "max-stream-duration" }
      ]) {
        await context.test(timeout.code, async () => {
          const raw = new StalledReply();
          const cancellations = [];
          const upstreamResponse = { body: new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(`data: ${JSON.stringify(EVENTS[backendRouteKey])}\n\n`));
              if (backendRouteKey === "messages") {
                controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`));
                controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`));
              }
            },
            cancel(reason) { cancellations.push(reason); }
          }) };
          let guardExpired = false;
          const guard = setTimeout(() => {
            guardExpired = true;
            raw.destroy();
          }, 250);
          try {
            const handler = routeKey === backendRouteKey ? streamPassthrough : streamShim;
            const result = await handler({
              upstreamResponse, reply: { raw }, routeKey, backendRouteKey, modelId: "test-model", model: {},
              policy: { firstByteTimeoutMs: 1000, ...timeout.policy },
              onFirstChunk() {}, onUsage() {}, onModel() {}
            });
            assert.equal(guardExpired, false, "Stream must terminate without external downstream cleanup");
            assert.equal(result.ok, false);
            assert.equal(result.error?.code, timeout.code);
            assert.equal(result.beforeFirstChunk, false);
            assert.equal(result.clientDisconnected, false);
            assert.deepEqual(cancellations, [timeout.reason]);
            assert.equal(raw.destroyed, true, "A timed-out blocked socket must not receive further error frames");
            for (const event of ["drain", "close", "error"]) assert.equal(raw.listenerCount(event), 0);
          } finally {
            clearTimeout(guard);
            raw.destroy();
          }
        });
      }
    });
  }
}