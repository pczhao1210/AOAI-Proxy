import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { parseJsonWithTimeout, readTextWithTimeout } from "../src/proxy/reliability.js";

const readers = [
  { name: "text", read: readTextWithTimeout, expected: value => value },
  { name: "JSON", read: parseJsonWithTimeout, expected: value => JSON.parse(value) }
];

function chunkedResponse(bytes, onCancel = () => {}) {
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    },
    cancel: onCancel
  }));
}

for (const { name, read, expected } of readers) {
  test(`${name} reader preserves split UTF-8 and exact byte limits`, async () => {
    const text = JSON.stringify({ text: "\u4f60\u597d \ud83c\udf0d" });
    const bytes = Buffer.from(text);
    const controller = new AbortController();
    assert.deepEqual(await read(chunkedResponse(bytes), 1000, bytes.length, controller.signal), expected(text));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(await read(chunkedResponse(bytes), 1000, 0), expected(text));
    const cancellations = [];
    await assert.rejects(read(chunkedResponse(bytes, reason => cancellations.push(reason)), 1000, bytes.length - 1), {
      code: "UPSTREAM_RESPONSE_TOO_LARGE",
      message: `Upstream response exceeds ${bytes.length - 1} bytes`
    });
    assert.deepEqual(cancellations, ["response-too-large"]);
  });

  test(`${name} reader cancels stalled bodies on timeout and removes listeners`, async () => {
    const controller = new AbortController();
    const cancellations = [];
    const response = new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: reason => cancellations.push(reason)
    }));
    await assert.rejects(read(response, 15, 1024, controller.signal), {
      code: "UPSTREAM_REQUEST_TIMEOUT", message: "request timeout after 15ms"
    });
    assert.deepEqual(cancellations, ["request-timeout"]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test(`${name} reader handles already-aborted and in-flight client cancellation`, async () => {
    for (const alreadyAborted of [true, false]) {
      const controller = new AbortController();
      const cancellations = [];
      const response = new Response(new ReadableStream({
        pull: () => new Promise(() => {}),
        cancel: reason => cancellations.push(reason)
      }));
      if (alreadyAborted) controller.abort("client-disconnected");
      const result = read(response, 1000, 1024, controller.signal);
      const rejected = assert.rejects(result, { code: "CLIENT_DISCONNECTED", message: "client disconnected" });
      if (!alreadyAborted) controller.abort("client-disconnected");
      await rejected;
      assert.deepEqual(cancellations, ["client-disconnected"]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  });

  test(`${name} reader preserves upstream read errors and unavailable-body errors`, async () => {
    const failure = new Error("socket read failed");
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ pull(stream) { stream.error(failure); } }));
    await assert.rejects(read(response, 1000, 1024, controller.signal), error => error === failure);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(read(new Response(null), 1000), {
      code: "UPSTREAM_FETCH_FAILED", message: "response body unavailable"
    });
  });

  test(`${name} size rejection does not wait for upstream cancellation cleanup`, async () => {
    const cancellations = [];
    const controller = new AbortController();
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(Buffer.from("[]")); },
      cancel(reason) {
        cancellations.push(reason);
        return new Promise(() => {});
      }
    }));
    let timer;
    try {
      const result = await Promise.race([
        read(response, 20, 1, controller.signal).then(() => ({ code: "UNEXPECTED_SUCCESS" }), error => error),
        new Promise(resolve => { timer = setTimeout(() => resolve({ code: "TEST_GUARD_TIMEOUT" }), 100); })
      ]);
      assert.equal(result.code, "UPSTREAM_RESPONSE_TOO_LARGE");
      assert.deepEqual(cancellations, ["response-too-large"]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      clearTimeout(timer);
    }
  });
}

test("JSON parsing remains separate from text and preserves native SyntaxError", async () => {
  for (const text of ["", "not JSON", '{"unfinished":']) {
    assert.equal(await readTextWithTimeout(new Response(text), 1000), text);
    const controller = new AbortController();
    await assert.rejects(parseJsonWithTimeout(new Response(text), 1000, 0, controller.signal), SyntaxError);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  for (const text of ["null", "true", "123", '"text"', "[]", "{}"]) {
    assert.deepEqual(await parseJsonWithTimeout(new Response(text), 1000), JSON.parse(text));
  }
});