import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRawSseParser, streamPassthrough, streamShim } from "../src/proxy/stream.js";

const LIMIT = 8 * 1024 * 1024;
const encode = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const terminals = {
  "chat/completions": encode({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) + encode("[DONE]"),
  responses: encode({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" })
    + encode({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  messages: encode({ type: "message_start", message: { id: "msg_1", role: "assistant", model: "test", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
    + encode({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + encode({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })
    + encode({ type: "content_block_stop", index: 0 })
    + encode({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
    + encode({ type: "message_stop" })
};

async function runStream(routeKey, backendRouteKey, chunks, { writeError = false } = {}) {
  const cancellations = [];
  const raw = new EventEmitter();
  raw.bytes = 0;
  raw.write = chunk => {
    if (writeError) throw new Error("downstream write failed");
    raw.bytes += Buffer.byteLength(chunk);
    return true;
  };
  let source;
  const body = new ReadableStream({
    start(controller) { source = controller; for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); },
    cancel(reason) { cancellations.push(reason); }
  });
  try {
    const result = await (routeKey === backendRouteKey ? streamPassthrough : streamShim)({
      upstreamResponse: { body }, reply: { raw }, modelId: "test", model: {}, routeKey, backendRouteKey,
      policy: { firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, maxStreamDurationMs: 0 },
      onFirstChunk() {}, onUsage() {}
    });
    return { result, cancellations, raw, locked: body.locked };
  } finally { if (!cancellations.length) source.close(); }
}

test("all text directions cancel and unlock upstream readers on terminal and downstream failure", async t => {
  for (const routeKey of Object.keys(terminals)) for (const backendRouteKey of Object.keys(terminals)) {
    for (const writeError of [false, true]) await t.test(`${routeKey} -> ${backendRouteKey} ${writeError ? "write error" : "terminal"}`, async () => {
      const { result, cancellations, locked, raw } = await runStream(routeKey, backendRouteKey, [terminals[backendRouteKey]], { writeError });
      assert.equal(result.ok, !writeError);
      assert.equal(cancellations.length, 1, "An upstream that keeps HTTP open must still be cancelled exactly once");
      assert.equal(locked, false);
      assert.equal(raw.listenerCount("close"), 0);
    });
  }
});

test("SSE parser enforces raw event bytes including delimiters before decoding", () => {
  for (const delimiter of ["\n\n", "\r\n\r\n"]) {
    const prefix = "data: ";
    const limit = 64;
    const exact = Buffer.from(prefix + "x".repeat(limit - prefix.length - delimiter.length) + delimiter);
    assert.equal([...createRawSseParser({ maxEventBytes: limit }).feed(exact)][0].raw.length, limit);
    for (const extra of [Buffer.from("x"), Buffer.from("中")]) {
      const tooLarge = Buffer.concat([exact.subarray(0, -delimiter.length), extra, Buffer.from(delimiter)]);
      for (const split of [0, limit - 1, limit]) {
        const parser = createRawSseParser({ maxEventBytes: limit });
        assert.throws(() => {
          [...parser.feed(tooLarge.subarray(0, split))];
          [...parser.feed(tooLarge.subarray(split))];
        }, { code: "UPSTREAM_STREAM_EVENT_TOO_LARGE" });
      }
    }
    const parser = createRawSseParser({ maxEventBytes: limit });
    assert.equal([...parser.feed(Buffer.concat([exact, exact, exact]))].length, 3, "The limit is per event, not per network chunk");
  }
  const parser = createRawSseParser({ maxEventBytes: 16 });
  assert.throws(() => [...parser.feed(Buffer.from("x".repeat(17)))], { code: "UPSTREAM_STREAM_EVENT_TOO_LARGE" });
});

test("oversized complete and unfinished SSE events fail before forwarding and release upstream", async t => {
  const oversized = Buffer.from(encode({ choices: [{ index: 0, delta: { content: "x".repeat(LIMIT) }, finish_reason: null }] }));
  for (const routeKey of ["chat/completions", "responses"]) {
    for (const complete of [false, true]) await t.test(`${routeKey} -> chat/completions: ${complete ? "complete" : "unfinished"}`, async () => {
      const event = complete ? oversized : oversized.subarray(0, -2);
      const { result, cancellations, raw, locked } = await runStream(routeKey, "chat/completions", [event.subarray(0, LIMIT - 1), event.subarray(LIMIT - 1)]);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "UPSTREAM_STREAM_EVENT_TOO_LARGE");
      assert.equal(raw.bytes, 0);
      assert.equal(cancellations.length, 1);
      assert.equal(locked, false);
    });
  }
});

test("terminal evidence discards oversized trailing bytes in the same chunk", async () => {
  for (const routeKey of ["chat/completions", "responses"]) {
    const { result, cancellations } = await runStream(routeKey, "chat/completions", [terminals["chat/completions"] + "x".repeat(LIMIT + 1)]);
    assert.equal(result.ok, true);
    assert.equal(cancellations.length, 1);
  }
});
