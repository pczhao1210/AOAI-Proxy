import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
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

// Reference framing: the earliest "\n\n" or "\r\n\r\n" ends an event; trailing bytes are the final partial event.
function referenceSseFrames(data) {
  const frames = [];
  let rest = data;
  for (;;) {
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    if (lf < 0 && crlf < 0) break;
    const useCrlf = crlf >= 0 && (lf < 0 || crlf < lf);
    const length = (useCrlf ? crlf + 4 : lf + 2);
    frames.push(rest.subarray(0, length).toString("hex"));
    rest = rest.subarray(length);
  }
  if (rest.length) frames.push(rest.toString("hex"));
  return frames;
}

function parseInChunks(chunks, options) {
  const parser = createRawSseParser(options);
  const frames = [];
  for (const chunk of chunks) for (const event of parser.feed(chunk)) frames.push(event.raw.toString("hex"));
  for (const event of parser.finish()) frames.push(event.raw.toString("hex"));
  return { frames, buffered: parser.bufferedLength };
}

test("SSE parser frames events identically for every delimiter split and random chunking", () => {
  const stream = Buffer.from(
    "data: one\n\ndata: 中文\r\n\r\n\n\n\r\n\r\n: comment\n\ndata: a\r\ndata: b\n\r\n\r\n\ndata: tail"
  );
  const expected = referenceSseFrames(stream);
  for (let size = 1; size <= stream.length; size += 1) {
    const chunks = [];
    for (let offset = 0; offset < stream.length; offset += size) chunks.push(stream.subarray(offset, offset + size));
    assert.deepEqual(parseInChunks(chunks).frames, expected, `chunk size ${size}`);
  }
  for (let split = 0; split <= stream.length; split += 1) {
    assert.deepEqual(parseInChunks([stream.subarray(0, split), stream.subarray(split)]).frames, expected, `split ${split}`);
  }

  let seed = 20240607;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pieces = ["\n", "\r", "\r\n", "\n\n", "\r\n\r\n", "a", "data: x", "中", ":"];
  for (let run = 0; run < 1500; run += 1) {
    let text = "";
    for (let count = 1 + Math.floor(random() * 20); count > 0; count -= 1) text += pieces[Math.floor(random() * pieces.length)];
    const data = Buffer.from(text);
    const chunks = [];
    for (let offset = 0; offset < data.length;) {
      const size = 1 + Math.floor(random() * 6);
      chunks.push(data.subarray(offset, offset + size));
      offset += size;
    }
    const { frames, buffered } = parseInChunks(chunks);
    assert.deepEqual(frames, referenceSseFrames(data), JSON.stringify(text));
    assert.equal(buffered, 0);
  }
});

test("SSE parser reports unfinished bytes and resumes after an abandoned iterator", () => {
  const parser = createRawSseParser();
  assert.deepEqual([...parser.feed(Buffer.from("data: a\n"))], []);
  assert.equal(parser.bufferedLength, 8);
  const [first] = parser.feed(Buffer.from("\ndata: b\n\ndata: c\n\ndata: d"));
  assert.equal(first.payload, "a");
  assert.equal(parser.bufferedLength, "data: b\n\ndata: c\n\ndata: d".length);
  const resumed = [...parser.feed(Buffer.from("\n\n"))];
  assert.deepEqual(resumed.map(event => event.payload), ["b", "c", "d"]);
  assert.equal(parser.bufferedLength, 0);
});

test("SSE parser joins a split event once and never copies events contained in one chunk", () => {
  const body = "x".repeat(1024 * 1024);
  const big = Buffer.from(`data: ${body}\r\n\r\n`);
  const copy = mock.method(Buffer, "concat");
  try {
    const parser = createRawSseParser();
    const events = [];
    for (let offset = 0; offset < big.length; offset += 1024) {
      events.push(...parser.feed(big.subarray(offset, offset + 1024)));
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.length, body.length);
    assert.equal(events[0].raw.length, big.length);
    const copiedBytes = copy.mock.calls.reduce((total, call) => total + call.result.length, 0);
    assert.ok(copiedBytes <= big.length * 1.1, `copied ${copiedBytes} bytes for a ${big.length} byte event`);
  } finally {
    copy.mock.restore();
  }

  const chunk = Buffer.from("data: a\n\ndata: b\r\n\r\ndata: c\n\n");
  const events = [...createRawSseParser().feed(chunk)];
  assert.equal(events.length, 3);
  for (const event of events) assert.equal(event.raw.buffer, chunk.buffer, "complete events are views of the incoming chunk");
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
