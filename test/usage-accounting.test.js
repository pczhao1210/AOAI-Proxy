import assert from "node:assert/strict";
import test from "node:test";
import { recordGovernanceUsage, getGovernanceSnapshot, checkUnmeteredRequestAccess } from "../src/governance.js";
import { getStats, recordUsage, recordMediaUsage } from "../src/stats.js";
import { createMediaUsageTracker, normalizeMediaUsage, estimateMediaCost } from "../src/proxy/media-usage.js";
import { resolveMediaPricing, settleMediaUsage } from "../src/proxy/media-accounting.js";

const model = { id: "gpt-4o", targetModel: "gpt-4o", pricingRef: "gpt-4o" };
const config = { models: [model], access: { budgets: { enabled: false, defaultCurrency: "USD" } } };
const counters = ["promptTokens", "completionTokens", "totalTokens", "cachedTokens"];

const cases = [
  ["Chat", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } }, [10, 2, 12, 3]],
  ["Responses", { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } }, [10, 2, 12, 3]],
  ["Messages cache", { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, [12, 1, 13, 7]],
  ["mapped cache precedence", { prompt_tokens: 12, input_tokens: 2, completion_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, prompt_tokens_details: { cached_tokens: 0 }, input_tokens_details: { cached_tokens: 9 } }, [12, 1, 13, 0]],
  ["explicit zero", { prompt_tokens: 4, completion_tokens: 0, output_tokens: 99, total_tokens: 0, total: 100 }, [4, 0, 0, 0]],
  ["numeric strings", { input_tokens: "2", output_tokens: "1", cache_read_input_tokens: "7", cache_creation_input_tokens: "3" }, [12, 1, 13, 7]],
  ["invalid counters", { prompt_tokens: -1, completion_tokens: 1.2, total_tokens: "unknown", cached_tokens: NaN }, [0, 0, 0, 0]]
];

for (const [index, [name, usage, expected]] of cases.entries()) {
  test(`${name} usage agrees across governance and all statistics buckets without mutating wire data`, () => {
    const keyId = `usage-key-${index}`;
    const modelId = `usage-model-${index}`;
    const original = structuredClone(usage);
    const before = { ...getStats().totals };
    const cost = recordGovernanceUsage(config, { keyId, apiKey: {} }, model, usage, Date.now(), "gpt-4o");
    assert.deepEqual(counters.map(field => cost[field]), expected);
    recordUsage(modelId, usage, { keyId, cost, actualModelName: "gpt-4o-2024-11-20" });
    const stats = getStats();
    for (const bucket of [stats.perModel[modelId], stats.perKey[keyId], stats.perModel[modelId].actualModels["gpt-4o"]]) {
      assert.deepEqual(counters.map(field => bucket[field]), expected);
    }
    assert.deepEqual(counters.map(field => stats.totals[field] - before[field]), expected);
    assert.deepEqual(usage, original);
  });
}

test("media usage preserves explicit zero and never infers time or cost from bytes", () => {
  const raw = { type: "tokens", input_tokens: 10, output_tokens: 0, total_tokens: 10,
    input_token_details: { audio_tokens: 8, text_tokens: 2, cached_tokens: 0 }, extension: { preserved: true } };
  const original = structuredClone(raw);
  const normalized = normalizeMediaUsage(raw);
  assert.equal(normalized.raw, raw);
  assert.deepEqual(normalized.counters, { inputTokens: 10, outputTokens: 0, totalTokens: 10, inputAudioTokens: 8, inputTextTokens: 2, cachedTokens: 0 });
  assert.equal(normalized.costStatus, "unknown");
  assert.equal(normalized.estimatedCostAmount, null);
  assert.deepEqual(normalizeMediaUsage({ type: "duration", seconds: 1.25 }).counters, { durationSeconds: 1.25 });
  assert.deepEqual(normalizeMediaUsage({ input_characters: 0 }).counters, { inputCharacters: 0 });
  assert.deepEqual(normalizeMediaUsage({ bytes: 32000 }).counters, {});
  assert.deepEqual(normalizeMediaUsage({ input_tokens: null, output_tokens: -1 }).counters, {});
  assert.equal(normalizeMediaUsage(null).usageStatus, "unknown");
  assert.deepEqual(raw, original);
});

test("media accounting deduplicates item terminals and records cumulative usage deltas without regressing", () => {
  const tracker = createMediaUsageTracker({ maxItems: 2 });
  assert.deepEqual(tracker.observe("response:1", { input_tokens: 4, output_tokens: 0, total_tokens: 4 }).counters, { inputTokens: 4, outputTokens: 0, totalTokens: 4 });
  assert.equal(tracker.observe("response:1", { input_tokens: 4, output_tokens: 0, total_tokens: 4 }), null);
  assert.deepEqual(tracker.observe("session", { type: "duration", seconds: 2 }, { cumulative: true }).counters, { durationSeconds: 2 });
  assert.deepEqual(tracker.observe("session", { type: "duration", seconds: 3.5 }, { cumulative: true }).counters, { durationSeconds: 1.5 });
  assert.equal(tracker.observe("session", { type: "duration", seconds: 2 }, { cumulative: true }), null);
  assert.deepEqual(tracker.snapshot().counters, { inputTokens: 4, outputTokens: 0, totalTokens: 4, durationSeconds: 3.5 });
  assert.throws(() => tracker.observe("response:2", { total_tokens: 1 }), { code: "MEDIA_USAGE_CAPACITY" });
});

test("media pricing separates modalities and caches and rejects incomplete counters", () => {
  const pricing = { currency: "USD", billingUnit: "1M tokens", inputPer1mTokens: 4, cachedInputPer1mTokens: 0.4,
    outputPer1mTokens: 24, channels: { audio: { inputPer1mTokens: 32, cachedInputPer1mTokens: 0.4, outputPer1mTokens: 64 },
      image: { inputPer1mTokens: 5, cachedInputPer1mTokens: 0.5 } } };
  const raw = { input_tokens: 100, output_tokens: 30, total_tokens: 130,
    input_token_details: { text_tokens: 20, audio_tokens: 70, image_tokens: 10, cached_tokens: 15,
      cached_tokens_details: { text_tokens: 5, audio_tokens: 8, image_tokens: 2 } },
    output_token_details: { text_tokens: 10, audio_tokens: 20 } };
  const original = structuredClone(raw);
  const cost = estimateMediaCost(normalizeMediaUsage(raw), pricing);
  assert.equal(cost.costStatus, "priced");
  assert.ok(Math.abs(cost.estimatedCostAmount - (15 * 4 + 5 * 0.4 + 62 * 32 + 8 * 0.4 + 8 * 5 + 2 * 0.5 + 10 * 24 + 20 * 64) / 1000000) < 1e-12);
  assert.deepEqual(raw, original);
  for (const broken of [
    { ...raw, total_tokens: 999 },
    { ...raw, output_token_details: { text_tokens: 10 } },
    { ...raw, input_token_details: { ...raw.input_token_details, cached_tokens_details: undefined } },
    { ...raw, input_token_details: { ...raw.input_token_details, image_tokens: 9 } }
  ]) assert.equal(estimateMediaCost(normalizeMediaUsage(broken), pricing).estimatedCostAmount, null);
  assert.equal(estimateMediaCost(normalizeMediaUsage(raw), { ...pricing, channels: {} }).estimatedCostAmount, null);
  assert.equal(estimateMediaCost({ ...normalizeMediaUsage(raw), usageStatus: "partial" }, pricing).estimatedCostAmount, null);
  const zero = normalizeMediaUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0, input_token_details: { cached_tokens: 0 } });
  assert.equal(estimateMediaCost(zero, pricing).estimatedCostAmount, 0);
});

test("media duration and character pricing use explicit units and distinguish unknown from free", () => {
  const duration = normalizeMediaUsage({ type: "duration", seconds: 90 });
  assert.ok(Math.abs(estimateMediaCost(duration, { currency: "USD", billingUnit: "minute", perMinute: 0.006 }).estimatedCostAmount - 0.009) < 1e-12);
  const realtime = { currency: "USD", billingUnit: "minute", realtimeAudioDurationPerMinute: 0.034, realtimeAudioDurationPerSecond: 0.00057 };
  assert.ok(Math.abs(estimateMediaCost(duration, realtime).estimatedCostAmount - 0.051) < 1e-12);
  assert.equal(estimateMediaCost(duration, { ...realtime, realtimeAudioDurationPerMinute: 0 }).estimatedCostAmount, 0);
  assert.equal(estimateMediaCost(normalizeMediaUsage({ input_characters: 1000 }), { currency: "USD", billingUnit: "1M characters", per1mCharacters: 15 }).estimatedCostAmount, 0.015);
  for (const pricing of [null, {}, { ...realtime, status: "unavailable" }, { currency: "USD", billingUnit: "image", perImage: 1 }]) {
    assert.equal(estimateMediaCost(duration, pricing).estimatedCostAmount, null);
  }
  assert.equal(estimateMediaCost(normalizeMediaUsage(null), realtime).estimatedCostAmount, null);
});

test("media tracker sums USD unit prices regardless of legacy labels and preserves unknowns and snapshots", () => {
  const pricing = { currency: "USD", billingUnit: "minute", perMinute: 0.006 };
  const tracker = createMediaUsageTracker({ pricing });
  tracker.observe("first", { type: "duration", seconds: 30 });
  pricing.perMinute = 100;
  tracker.observe("first", { type: "duration", seconds: 60 }, { cumulative: true });
  tracker.observe("first", { type: "duration", seconds: 10 }, { cumulative: true });
  assert.equal(tracker.snapshot().estimatedCostAmount, 0.006);
  assert.equal(tracker.observe("first", { type: "duration", seconds: 60 }), null);
  tracker.observe("second", { type: "duration", seconds: 60 }, { pricing: { currency: "EUR", billingUnit: "minute", perMinute: 0.01 } });
  tracker.observe("third", { type: "duration", seconds: 60 }, { pricing: { billingUnit: "minute", perMinute: 0.002 } });
  assert.equal(tracker.snapshot().estimatedCostAmount, 0.018000000000000002);
  assert.equal(tracker.snapshot().currency, "USD");
  assert.deepEqual(tracker.snapshot().knownCostAmounts, { USD: 0.018000000000000002 });
  tracker.observe("missing", null);
  assert.equal(tracker.snapshot().usageStatus, "partial");
  assert.equal(tracker.snapshot().unknownUsageItems, 1);
  assert.equal(tracker.snapshot().unknownCostItems, 1);
  recordMediaUsage("media-mixed", tracker.snapshot(), { keyId: "media-mixed-key" });
  assert.deepEqual(getStats().perModel["media-mixed"].media.costAmounts, { USD: 0.018000000000000002 });
  assert.equal(getStats().perModel["media-mixed"].media.estimatedCostAmount, null);
});

test("media settlement preserves hosting prices and sums USD amounts independent of budget labels", async () => {
  const voice = { id: "whisper-1", pricingRef: "whisper-1" };
  const upstream = { provider: "openai" };
  const pricing = resolveMediaPricing(config, voice, upstream, null, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(pricing.perMinute, 0.006);
  assert.equal(resolveMediaPricing(config, voice, { provider: "azure-openai" }, null, "https://resource.openai.azure.com/openai/v1/audio/transcriptions"), null);
  assert.equal(resolveMediaPricing(config, voice, upstream, null, "https://custom.example/openai/v1/audio/transcriptions"), null);
  assert.equal(resolveMediaPricing(config, { ...voice, pricing: { inputPer1kTokens: 1 } }, upstream, null, "https://api.openai.com/v1/audio/transcriptions"), null);
  const explicit = { ...voice, pricing: { currency: "EUR", billingUnit: "minute", perMinute: 0.01 } };
  assert.equal(resolveMediaPricing(config, explicit, { provider: "azure-openai" }, null, "https://example.com/speech").currency, "EUR");
  const tracker = createMediaUsageTracker({ pricing });
  tracker.observe("duration", { type: "duration", seconds: 60 });
  const consumer = { keyId: "media-settlement-key", apiKey: { budget: { currency: "EUR" } } };
  settleMediaUsage({ config, consumer, model: voice, usage: tracker.snapshot() });
  const snapshot = await getGovernanceSnapshot(config);
  const budget = snapshot.keys.find(key => key.keyId === consumer.keyId).runtime.budgetWindow;
  assert.equal(budget.spentAmount, 0.006);
  assert.equal(budget.mediaUnknownCostRequests, 0);
  assert.equal(checkUnmeteredRequestAccess(config, { ...consumer, apiKey: { rateLimit: { tpm: 100 } } }).ok, false);
  const foreign = createMediaUsageTracker({ pricing: explicit.pricing });
  foreign.observe("foreign", { type: "duration", seconds: 60 });
  settleMediaUsage({ config, consumer, model: voice, usage: foreign.snapshot() });
  const after = await getGovernanceSnapshot(config);
  assert.equal(after.keys.find(key => key.keyId === consumer.keyId).runtime.budgetWindow.spentAmount, 0.016);
  assert.equal(getStats().perKey[consumer.keyId].estimatedCostCurrency, "USD");
  assert.equal(consumer.apiKey.budget.currency, "EUR");
});

test("media statistics keep missing usage and unpriced requests separate from text pricing", () => {
  recordMediaUsage("media-observed", normalizeMediaUsage({ total_tokens: 0 }), { keyId: "media-key" });
  recordMediaUsage("media-observed", normalizeMediaUsage(null), { keyId: "media-key" });
  const bucket = getStats().perModel["media-observed"].media;
  assert.equal(bucket.requests, 2);
  assert.equal(bucket.observedRequests, 1);
  assert.equal(bucket.unknownUsageRequests, 1);
  assert.equal(bucket.unknownCostRequests, 2);
  assert.equal(bucket.estimatedCostAmount, null);
  assert.equal(bucket.counters.totalTokens, 0);
  assert.deepEqual(getStats().perKey["media-key"].media, bucket);
});