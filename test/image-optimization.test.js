import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { maybeCompressImages } from "../src/proxy/body.js";
import { optimizeInlineImage } from "../src/proxy/image-optimizer.js";
import { createImageFixtures } from "./lib/image-fixtures.js";

const fixtures = await createImageFixtures();
const ADAPTIVE_CONFIG = { media: { inputCompression: {
  enabled: true, mode: "adaptive", minBytes: 1, minSavingsRatio: 0.1,
  maxLongSidePx: 320, quality: 0.8, outputFormat: "jpeg"
} } };

function chatImage(buffer, mime) {
  return { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "high" } }] }] };
}

test("adaptive images preserve lossless text and transparent inputs", async () => {
  for (const fixture of [fixtures.screenshot, fixtures.transparent]) {
    const body = chatImage(fixture, "image/png");
    const original = structuredClone(body);
    await maybeCompressImages(body, ADAPTIVE_CONFIG, "chat/completions");
    assert.ok(JSON.stringify(body) === JSON.stringify(original), "Lossless input must remain byte-identical");
  }
});

test("adaptive images below the byte threshold remain byte-identical", async () => {
  const body = chatImage(fixtures.photo, "image/jpeg");
  const original = structuredClone(body);
  await maybeCompressImages(body, { media: { inputCompression: {
    ...ADAPTIVE_CONFIG.media.inputCompression, minBytes: fixtures.photo.length + 1
  } } }, "chat/completions");
  assert.ok(JSON.stringify(body) === JSON.stringify(original), "Small images must remain byte-identical");
});

test("disabled image optimization preserves existing native payloads", async () => {
  const body = chatImage(fixtures.photo, "image/jpeg");
  const original = structuredClone(body);
  await maybeCompressImages(body, { media: { inputCompression: { enabled: false } } }, "chat/completions");
  assert.ok(JSON.stringify(body) === JSON.stringify(original), "Disabled optimization must preserve the payload");
});

test("adaptive JPEG optimization reduces bytes and applies EXIF orientation without cropping", async () => {
  const optimized = await optimizeInlineImage(fixtures.rotated, ADAPTIVE_CONFIG.media.inputCompression);
  assert.equal(optimized.reason, "optimized");
  assert.ok(optimized.outputBytes <= optimized.inputBytes * 0.9);
  const metadata = await sharp(optimized.buffer).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 240);
  assert.equal(metadata.height, 320);
  assert.ok(!metadata.orientation || metadata.orientation === 1);
  assert.equal(metadata.hasProfile, true);
});

test("adaptive processing preserves animation, invalid inputs and decoder-limit fallbacks", async () => {
  assert.equal((await sharp(fixtures.animated).metadata()).pages, 2);
  for (const fixture of [fixtures.animated, fixtures.transparent, fixtures.screenshot, Buffer.from("invalid jpeg")]) {
    const output = await optimizeInlineImage(fixture, ADAPTIVE_CONFIG.media.inputCompression);
    assert.strictEqual(output.buffer, fixture);
    assert.notEqual(output.reason, "optimized");
  }
  const limited = await optimizeInlineImage(fixtures.photo, { ...ADAPTIVE_CONFIG.media.inputCompression, maxPixels: 10 });
  assert.equal(limited.reason, "processing_unavailable");
  assert.strictEqual(limited.buffer, fixtures.photo);
});

test("adaptive processing retains original bytes when savings are insufficient", async () => {
  const result = await optimizeInlineImage(fixtures.photo, { ...ADAPTIVE_CONFIG.media.inputCompression, minSavingsRatio: 0.999 });
  assert.equal(result.reason, "insufficient_savings");
  assert.strictEqual(result.buffer, fixtures.photo);
});

test("adaptive Messages optimization keeps MIME, cache controls and per-request deduplication", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: fixtures.photo.toString("base64") }, cache_control: { type: "ephemeral" } };
  const body = { messages: [{ role: "user", content: [image, structuredClone(image)] }] };
  const events = [];
  await maybeCompressImages(body, ADAPTIVE_CONFIG, "messages", { onImage: event => events.push(event) });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "optimized");
  assert.ok(!JSON.stringify(events).includes(image.source.data));
  assert.equal(image.source.media_type, "image/jpeg");
  assert.deepEqual(image.cache_control, { type: "ephemeral" });
  assert.equal(body.messages[0].content[1].source.data, image.source.data);
  assert.ok(Buffer.from(image.source.data, "base64").length < fixtures.photo.length);
});

test("adaptive processing observes cancellation before doing work", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(optimizeInlineImage(fixtures.photo, ADAPTIVE_CONFIG.media.inputCompression, { signal: controller.signal }), { code: "CLIENT_DISCONNECTED" });
});

test("explicit image count and aggregate budgets apply with compression disabled", async () => {
  const body = chatImage(Buffer.alloc(3), "image/png");
  body.messages[0].content.push(structuredClone(body.messages[0].content[0]));
  for (const [inlineImages, code] of [
    [{ maxImages: 1 }, "IMAGE_COUNT_LIMIT_EXCEEDED"],
    [{ maxTotalBytes: 5 }, "INLINE_IMAGES_TOTAL_TOO_LARGE"]
  ]) {
    await assert.rejects(maybeCompressImages(structuredClone(body), {
      media: { inputCompression: { enabled: false }, inlineImages }
    }, "chat/completions"), { code });
  }
  const original = structuredClone(body);
  await maybeCompressImages(body, { media: { inputCompression: { enabled: false }, inlineImages: { maxImages: 2, maxTotalBytes: 6 } } }, "chat/completions");
  assert.deepEqual(body, original);
});

test("explicit image count includes Responses file IDs without URL checks or encoding", async () => {
  const body = { input: [{ role: "user", content: [
    { type: "input_image", file_id: "file-one", detail: "high" },
    { type: "input_image", file_id: "file-two", detail: "low" }
  ] }] };
  await assert.rejects(maybeCompressImages(structuredClone(body), {
    media: { ...ADAPTIVE_CONFIG.media, inlineImages: { maxImages: 1 } }
  }, "responses"), { code: "IMAGE_COUNT_LIMIT_EXCEEDED" });
  const original = structuredClone(body);
  await maybeCompressImages(body, { media: { ...ADAPTIVE_CONFIG.media, inlineImages: { maxImages: 2 } } }, "responses");
  assert.deepEqual(body, original);
});

test("adaptive time budget falls back to original bytes", async () => {
  const result = await optimizeInlineImage(fixtures.photo, { ...ADAPTIVE_CONFIG.media.inputCompression, timeoutMs: 1 });
  assert.equal(result.reason, "timeout");
  assert.strictEqual(result.buffer, fixtures.photo);
});

test("preserve mode, remote URLs and image editing fields are never reencoded", async () => {
  const body = chatImage(fixtures.photo, "image/jpeg");
  const original = JSON.stringify(body);
  await maybeCompressImages(body, { media: { inputCompression: { enabled: true, mode: "preserve" } } }, "chat/completions");
  assert.equal(JSON.stringify(body) === original, true);
  const remote = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image?signature=private", detail: "high" } }] }] };
  const events = [];
  const before = structuredClone(remote);
  await maybeCompressImages(remote, { media: { ...ADAPTIVE_CONFIG.media, remoteImages: { allow: true } } }, "chat/completions", { onImage: event => events.push(event) });
  assert.deepEqual(remote, before);
  assert.deepEqual(events, [{ reason: "remote_passthrough" }]);
  const editing = { image_base64: fixtures.photo.toString("base64"), mask: fixtures.transparent.toString("base64") };
  const snapshot = JSON.stringify(editing);
  await maybeCompressImages(editing, ADAPTIVE_CONFIG, "images/edits");
  assert.equal(JSON.stringify(editing) === snapshot, true);
});