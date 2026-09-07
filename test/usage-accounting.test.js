import assert from "node:assert/strict";
import test from "node:test";
import { recordGovernanceUsage } from "../src/governance.js";
import { getStats, recordUsage } from "../src/stats.js";

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