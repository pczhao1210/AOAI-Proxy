import assert from "node:assert/strict";
import test from "node:test";
import { discoverOrdinaryChannel } from "../src/channel-discovery.js";

test("manual deployment lists are never filled with Azure catalog IDs; supported lists are exact and read-only", async () => {
  const up = { channelId: "team", provider: "azure-openai", baseUrl: "https://api.openai.com", auth: { mode: "apiKey", apiKey: "fixture" } };
  const config = { upstreams: [up] };
  let requests = 0;
  const fetchImpl = (url, opts) => {
    requests++;
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.headers.authorization, "Bearer fixture");
    return Response.json({ object: "list", data: [{ id: "team:x", object: "model" }] });
  };
  await assert.rejects(discoverOrdinaryChannel(config, "team", fetchImpl), { code: "CHANNEL_DISCOVERY_NOT_SUPPORTED" });
  assert.equal(requests, 0);
  up.provider = "openai";
  assert.deepEqual((await discoverOrdinaryChannel(config, "team", fetchImpl)).models, [{ id: "team:x" }]);
  assert.equal(up.modelMappings, undefined);
  await assert.rejects(discoverOrdinaryChannel(config, "team", async () => Response.json({ object: "list", has_more: true, data: [] })), {
    code: "CHANNEL_DISCOVERY_FAILED"
  });
});
