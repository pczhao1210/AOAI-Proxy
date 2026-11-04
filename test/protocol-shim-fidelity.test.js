import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

const BACKENDS = {
  chat: "chat/completions",
  responses: "responses",
  messages: "messages"
};

function sseFrames(protocol, events) {
  return events.map((event) => {
    if (typeof event === "string") return `data: ${event}\n\n`;
    const prefix = protocol === "messages" ? `event: ${event.type}\n` : "";
    return `${prefix}data: ${JSON.stringify(event)}\n\n`;
  }).join("");
}

function parseSse(text) {
  return text.split("\n\n").flatMap((block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  });
}

async function withFidelityContext(run) {
  let script = null;
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    for (const [slug, backend] of Object.entries(BACKENDS)) {
      config.models.push({
        id: `fidelity-${slug}`,
        targetModel: `fidelity-${slug}-deployment`,
        upstream: "mock-foundry",
        pricingRef: slug === "messages" ? "claude-sonnet-4-6" : "gpt-5-mini",
        routes: { "*": backend }
      });
    }
    const save = async (next) => {
      const saved = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: next
      });
      assert.equal(saved.status, 200, saved.text);
    };
    await save(config);
    await run({
      ctx,
      setUpstream(factory) {
        script = factory;
      },
      async setProtocolShim(patch) {
        const next = await ctx.readConfigFile();
        next.compatibility = {
          ...(next.compatibility || {}),
          protocolShim: { ...(next.compatibility?.protocolShim || {}), ...patch }
        };
        await save(next);
      },
      upstreamCalls(model) {
        return ctx.upstreamRequests.filter((item) => item.body?.model === model);
      }
    });
  }, {
    upstreamHandler({ req, res, body }) {
      if (!script || !String(body?.model).startsWith("fidelity-")) return false;
      const protocol = req.url.endsWith("/messages") ? "messages" : req.url.endsWith("/responses") ? "responses" : "chat";
      const { json, events } = script({ body, protocol });
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(body.stream ? sseFrames(protocol, events) : JSON.stringify(json));
      return true;
    }
  });
}

function messagesToolStream(blocks) {
  const model = "fidelity-messages-deployment";
  const events = [{
    type: "message_start",
    message: {
      id: "msg_tool_stream",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 }
    }
  }];
  blocks.forEach((block, index) => {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
    });
    for (const partial_json of block.deltas) {
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" }
  );
  return { events };
}

function chatCompletion(finishReason) {
  const model = "fidelity-chat-deployment";
  const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  return {
    json: {
      id: "chatcmpl-fidelity",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "partial" }, finish_reason: finishReason }],
      usage
    },
    events: [
      {
        id: "chatcmpl-fidelity",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }]
      },
      {
        id: "chatcmpl-fidelity",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage
      },
      "[DONE]"
    ]
  };
}

const lookupTool = {
  type: "function",
  function: { name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } } } }
};

test("Messages tool_use stream to Chat sends tool id and name once, then arguments-only deltas", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, upstreamCalls }) => {
    setUpstream(() => messagesToolStream([{ id: "toolu_1", name: "lookup", deltas: ['{"city":', '"Paris"}'] }]));
    const result = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: {
        model: "fidelity-messages",
        stream: true,
        max_tokens: 64,
        tools: [lookupTool],
        messages: [{ role: "user", content: "weather" }]
      }
    });
    assert.equal(result.status, 200, result.text);
    assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1);
    const toolDeltas = parseSse(result.text)
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
    assert.deepEqual(toolDeltas.map((delta) => delta.function.arguments), ["", '{"city":', '"Paris"}']);
    assert.deepEqual(toolDeltas[0], {
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "lookup", arguments: "" }
    });
    for (const delta of toolDeltas.slice(1)) {
      assert.deepEqual(Object.keys(delta).sort(), ["function", "index"]);
      assert.deepEqual(Object.keys(delta.function), ["arguments"]);
      assert.equal(delta.index, 0);
    }
    assert.equal(toolDeltas.map((delta) => delta.function.arguments).join(""), '{"city":"Paris"}');
    const finish = parseSse(result.text).flatMap((chunk) => chunk.choices || []).find((choice) => choice.finish_reason);
    assert.equal(finish?.finish_reason, "tool_calls");
    assert.equal(upstreamCalls("fidelity-messages-deployment").length, 1);
  });
});

test("Messages parallel tool_use blocks to Chat keep one start per tool and separate indexes", async () => {
  await withFidelityContext(async ({ ctx, setUpstream }) => {
    setUpstream(() => messagesToolStream([
      { id: "toolu_a", name: "lookup", deltas: ['{"city":', '"Paris"}'] },
      { id: "toolu_b", name: "lookup", deltas: ['{"city":"Rome"}'] }
    ]));
    const result = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: {
        model: "fidelity-messages",
        stream: true,
        max_tokens: 64,
        tools: [lookupTool],
        messages: [{ role: "user", content: "weather" }]
      }
    });
    assert.equal(result.status, 200, result.text);
    const toolDeltas = parseSse(result.text).flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
    const starts = toolDeltas.filter((delta) => delta.id != null || delta.function?.name != null);
    assert.deepEqual(starts.map((delta) => [delta.index, delta.id, delta.function.name]), [
      [0, "toolu_a", "lookup"],
      [1, "toolu_b", "lookup"]
    ]);
    const argumentsByIndex = new Map();
    for (const delta of toolDeltas) {
      argumentsByIndex.set(delta.index, (argumentsByIndex.get(delta.index) || "") + delta.function.arguments);
    }
    assert.deepEqual([...argumentsByIndex], [[0, '{"city":"Paris"}'], [1, '{"city":"Rome"}']]);
  });
});

const toolTurn = (content) => [
  { role: "user", content: "weather" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"city":"Paris"}' } }]
  },
  { role: "tool", tool_call_id: "call_1", content }
];

function responsesCompleted() {
  const model = "fidelity-responses-deployment";
  const response = {
    id: "resp_fidelity",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [{
      id: "msg_fidelity",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }]
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
  };
  return {
    json: response,
    events: [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_text.delta", item_id: "msg_fidelity", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.completed", response }
    ]
  };
}

test("Chat tool-result text arrays reach the Responses upstream as function_call_output text", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim, upstreamCalls }) => {
    setUpstream(responsesCompleted);
    for (const strict of [false, true]) {
      await setProtocolShim({ rejectLossyRequests: strict });
      ctx.upstreamRequests.length = 0;
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "fidelity-responses",
          tools: [lookupTool],
          messages: toolTurn([{ type: "text", text: "temp: " }, { type: "text", text: "22C" }])
        }
      });
      assert.equal(result.status, 200, `strict=${strict}: ${result.text}`);
      const [upstream] = upstreamCalls("fidelity-responses-deployment");
      assert.ok(upstream.url.endsWith("/responses"), upstream.url);
      const calls = upstream.body.input.filter((item) => item.type === "function_call");
      const outputs = upstream.body.input.filter((item) => item.type === "function_call_output");
      assert.deepEqual(calls.map((item) => item.call_id), ["call_1"]);
      assert.deepEqual(outputs, [{ type: "function_call_output", call_id: "call_1", output: "temp: 22C" }]);
    }
  });
});

test("Chat string tool results and non-text tool arrays keep their existing Responses boundaries", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim, upstreamCalls }) => {
    setUpstream(responsesCompleted);
    const stringResult = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: { model: "fidelity-responses", tools: [lookupTool], messages: toolTurn("sunny") }
    });
    assert.equal(stringResult.status, 200, stringResult.text);
    assert.deepEqual(
      upstreamCalls("fidelity-responses-deployment")[0].body.input.filter((item) => item.type === "function_call_output"),
      [{ type: "function_call_output", call_id: "call_1", output: "sunny" }]
    );

    await setProtocolShim({ rejectLossyRequests: true });
    ctx.upstreamRequests.length = 0;
    const imageResult = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: {
        model: "fidelity-responses",
        tools: [lookupTool],
        messages: toolTurn([{ type: "image_url", image_url: { url: "https://example.test/a.png" } }])
      }
    });
    assert.ok(imageResult.status >= 400 && imageResult.status < 500, imageResult.text);
    assert.equal(upstreamCalls("fidelity-responses-deployment").length, 0, "proxy preflight rejection must not reach the upstream");
  });
});

test("Chat content_filter JSON maps to an incomplete Responses result and other reasons are unchanged", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim }) => {
    for (const rejectLossyResponses of [false, true]) {
      await setProtocolShim({ rejectLossyResponses });
      for (const [finishReason, status, incompleteDetails] of [
        ["content_filter", "incomplete", { reason: "content_filter" }],
        ["length", "incomplete", { reason: "max_output_tokens" }],
        ["stop", "completed", null]
      ]) {
        setUpstream(() => chatCompletion(finishReason));
        const result = await ctx.publicRequest("/v1/responses", {
          method: "POST",
          json: { model: "fidelity-chat", input: "hello" }
        });
        const label = `${finishReason} rejectLossyResponses=${rejectLossyResponses}`;
        assert.equal(result.status, 200, `${label}: ${result.text}`);
        assert.equal(result.json.status, status, label);
        assert.deepEqual(result.json.incomplete_details, incompleteDetails, label);
        assert.equal(result.json.output_text, "partial", label);
      }
    }
  });
});

test("Chat content_filter stream terminates the Responses stream as response.incomplete exactly once", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim }) => {
    for (const rejectLossyResponses of [false, true]) {
      await setProtocolShim({ rejectLossyResponses });
      for (const [finishReason, terminal, incompleteDetails] of [
        ["content_filter", "response.incomplete", { reason: "content_filter" }],
        ["length", "response.incomplete", { reason: "max_output_tokens" }],
        ["stop", "response.completed", null]
      ]) {
        setUpstream(() => chatCompletion(finishReason));
        const result = await ctx.publicRequest("/v1/responses", {
          method: "POST",
          json: { model: "fidelity-chat", input: "hello", stream: true }
        });
        const label = `${finishReason} rejectLossyResponses=${rejectLossyResponses}`;
        assert.equal(result.status, 200, `${label}: ${result.text}`);
        const terminals = parseSse(result.text).filter((event) => /^response\.(completed|incomplete)$/.test(event.type));
        assert.deepEqual(terminals.map((event) => event.type), [terminal], label);
        assert.deepEqual(terminals[0].response.incomplete_details, incompleteDetails, label);
        assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1, label);
      }
    }
  });
});

test("Chat content_filter is not representable for Messages clients and stays a strict-mode rejection", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim }) => {
    setUpstream(() => chatCompletion("content_filter"));
    await setProtocolShim({ rejectLossyResponses: true });
    const result = await ctx.publicRequest("/v1/messages", {
      method: "POST",
      json: { model: "fidelity-chat", max_tokens: 64, messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(result.status, 502, result.text);
    assert.equal(result.json?.error?.code, "UnsupportedProtocolShimResponse");
    assert.equal(result.json?.error?.param, "choices[0].finish_reason");
  });
});

function messagesCompleted() {
  const model = "fidelity-messages-deployment";
  const json = {
    id: "msg_fidelity",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 }
  };
  return {
    json,
    events: [
      { type: "message_start", message: { ...json, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" }
    ]
  };
}

function completedFor({ protocol }) {
  if (protocol === "messages") return messagesCompleted();
  if (protocol === "responses") return responsesCompleted();
  return chatCompletion("stop");
}

async function capture(ctx, upstreamCalls, path, json, upstreamModel) {
  ctx.upstreamRequests.length = 0;
  const result = await ctx.publicRequest(path, { method: "POST", json });
  return { result, upstream: upstreamCalls(upstreamModel).at(-1) };
}

test("Chat and Responses stop controls reach Messages as a stop_sequences array", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, upstreamCalls }) => {
    setUpstream(completedFor);
    for (const stream of [false, true]) {
      for (const [stop, expected] of [["END", ["END"]], [["A", "B"], ["A", "B"]]]) {
        const label = `chat stream=${stream} stop=${JSON.stringify(stop)}`;
        const { result, upstream } = await capture(ctx, upstreamCalls, "/v1/chat/completions", {
          model: "fidelity-messages", stream, max_tokens: 16, stop, messages: [{ role: "user", content: "hi" }]
        }, "fidelity-messages-deployment");
        assert.equal(result.status, 200, `${label}: ${result.text}`);
        assert.ok(upstream.url.endsWith("/messages"), upstream.url);
        assert.deepEqual(upstream.body.stop_sequences, expected, label);
        assert.equal(upstream.body.stop, undefined, label);
      }
    }
    const responses = await capture(ctx, upstreamCalls, "/v1/responses", {
      model: "fidelity-messages", input: "hi", max_output_tokens: 16, stop: "END"
    }, "fidelity-messages-deployment");
    assert.equal(responses.result.status, 200, responses.result.text);
    assert.deepEqual(responses.upstream.body.stop_sequences, ["END"]);
    assert.equal(responses.upstream.body.stop, undefined);
  });
});

test("Messages stop_sequences keep their existing array mapping to Responses and Chat upstreams", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, upstreamCalls }) => {
    setUpstream(completedFor);
    const toResponses = await capture(ctx, upstreamCalls, "/v1/messages", {
      model: "fidelity-responses", max_tokens: 16, stop_sequences: ["E"], messages: [{ role: "user", content: "hi" }]
    }, "fidelity-responses-deployment");
    assert.equal(toResponses.result.status, 200, toResponses.result.text);
    assert.deepEqual(toResponses.upstream.body.stop, ["E"]);
    const toChat = await capture(ctx, upstreamCalls, "/v1/messages", {
      model: "fidelity-chat", max_tokens: 16, stop_sequences: ["E"], messages: [{ role: "user", content: "hi" }]
    }, "fidelity-chat-deployment");
    assert.equal(toChat.result.status, 200, toChat.result.text);
    assert.deepEqual(toChat.upstream.body.stop, ["E"]);
  });
});

const parallelCases = [
  { name: "omitted tool_choice", toolChoice: undefined, expected: { type: "auto", disable_parallel_tool_use: true } },
  { name: "required", toolChoice: "required", expected: { type: "any", disable_parallel_tool_use: true } },
  { name: "none", toolChoice: "none", expected: { type: "none" } }
];

for (const client of ["chat", "responses"]) {
  test(`${client} parallel_tool_calls=false maps to Messages disable_parallel_tool_use without leaking the field`, async () => {
    await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim, upstreamCalls }) => {
      setUpstream(completedFor);
      const path = client === "chat" ? "/v1/chat/completions" : "/v1/responses";
      const tools = client === "chat"
        ? [lookupTool]
        : [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
      const base = client === "chat"
        ? { model: "fidelity-messages", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
        : { model: "fidelity-messages", max_output_tokens: 16, input: "hi" };
      const named = client === "chat"
        ? { type: "function", function: { name: "lookup" } }
        : { type: "function", name: "lookup" };
      const cases = [
        ...parallelCases,
        { name: "named function", toolChoice: named, expected: { type: "tool", name: "lookup", disable_parallel_tool_use: true } }
      ];
      for (const strict of [false, true]) {
        await setProtocolShim({ rejectLossyRequests: strict });
        for (const item of cases) {
          const label = `${client} strict=${strict} ${item.name}`;
          const { result, upstream } = await capture(ctx, upstreamCalls, path, {
            ...base, tools, parallel_tool_calls: false,
            ...(item.toolChoice === undefined ? {} : { tool_choice: item.toolChoice })
          }, "fidelity-messages-deployment");
          assert.equal(result.status, 200, `${label}: ${result.text}`);
          assert.deepEqual(upstream.body.tool_choice, item.expected, label);
          assert.equal("parallel_tool_calls" in upstream.body, false, label);
        }
      }
    });
  });

  test(`${client} parallel_tool_calls counterexamples add no Messages tool_choice`, async () => {
    await withFidelityContext(async ({ ctx, setUpstream, upstreamCalls }) => {
      setUpstream(completedFor);
      const path = client === "chat" ? "/v1/chat/completions" : "/v1/responses";
      const tools = client === "chat"
        ? [lookupTool]
        : [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
      const base = client === "chat"
        ? { model: "fidelity-messages", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
        : { model: "fidelity-messages", max_output_tokens: 16, input: "hi" };
      for (const [label, extra] of [
        ["parallel allowed", { tools, parallel_tool_calls: true }],
        ["parallel unset", { tools }],
        ["no tools", { parallel_tool_calls: false }]
      ]) {
        const { result, upstream } = await capture(ctx, upstreamCalls, path, { ...base, ...extra }, "fidelity-messages-deployment");
        assert.equal(result.status, 200, `${label}: ${result.text}`);
        assert.equal("tool_choice" in upstream.body, false, label);
        assert.equal("parallel_tool_calls" in upstream.body, false, label);
      }
    });
  });
}

test("Chat and Messages function tools default to strict=false on the Responses upstream", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, upstreamCalls }) => {
    setUpstream(completedFor);
    const schema = { type: "object", properties: { city: { type: "string" } } };
    const chat = await capture(ctx, upstreamCalls, "/v1/chat/completions", {
      model: "fidelity-responses",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "implicit", parameters: schema } },
        { type: "function", function: { name: "explicit_true", parameters: schema, strict: true } },
        { type: "function", function: { name: "explicit_false", parameters: schema, strict: false } }
      ]
    }, "fidelity-responses-deployment");
    assert.equal(chat.result.status, 200, chat.result.text);
    assert.deepEqual(chat.upstream.body.tools.map((tool) => [tool.name, tool.strict]), [
      ["implicit", false], ["explicit_true", true], ["explicit_false", false]
    ]);

    const messages = await capture(ctx, upstreamCalls, "/v1/messages", {
      model: "fidelity-responses",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "implicit", input_schema: schema },
        { name: "explicit_true", input_schema: schema, strict: true }
      ]
    }, "fidelity-responses-deployment");
    assert.equal(messages.result.status, 200, messages.result.text);
    assert.deepEqual(messages.upstream.body.tools.map((tool) => [tool.name, tool.strict]), [
      ["implicit", false], ["explicit_true", true]
    ]);

    const native = await capture(ctx, upstreamCalls, "/v1/responses", {
      model: "fidelity-responses",
      input: "hi",
      tools: [{ type: "function", name: "native", parameters: schema }]
    }, "fidelity-responses-deployment");
    assert.equal(native.result.status, 200, native.result.text);
    assert.equal("strict" in native.upstream.body.tools[0], false, "native Responses tools must stay untouched");
  });
});

test("Chat top_p reaches the Responses upstream while unsupported stop stays a Chat-to-Responses boundary", async () => {
  await withFidelityContext(async ({ ctx, setUpstream, setProtocolShim, upstreamCalls }) => {
    setUpstream(completedFor);
    for (const strict of [false, true]) {
      await setProtocolShim({ rejectLossyRequests: strict });
      for (const stream of [false, true]) {
        const label = `strict=${strict} stream=${stream}`;
        const { result, upstream } = await capture(ctx, upstreamCalls, "/v1/chat/completions", {
          model: "fidelity-responses", stream, top_p: 0.5, temperature: 0.2, messages: [{ role: "user", content: "hi" }]
        }, "fidelity-responses-deployment");
        assert.equal(result.status, 200, `${label}: ${result.text}`);
        assert.ok(upstream.url.endsWith("/responses"), upstream.url);
        assert.equal(upstream.body.top_p, 0.5, label);
        assert.equal(upstream.body.temperature, 0.2, label);
      }
    }

    const lossy = await capture(ctx, upstreamCalls, "/v1/chat/completions", {
      model: "fidelity-responses", stop: "END", messages: [{ role: "user", content: "hi" }]
    }, "fidelity-responses-deployment");
    assert.equal(lossy.result.status, 400, lossy.result.text);
    assert.equal(lossy.upstream, undefined, "proxy preflight rejection must not reach the upstream");

    await setProtocolShim({ rejectLossyRequests: false });
    const bestEffort = await capture(ctx, upstreamCalls, "/v1/chat/completions", {
      model: "fidelity-responses", stop: "END", top_p: 0.5, messages: [{ role: "user", content: "hi" }]
    }, "fidelity-responses-deployment");
    assert.equal(bestEffort.result.status, 200, bestEffort.result.text);
    assert.equal(bestEffort.upstream.body.top_p, 0.5);
    assert.equal("stop" in bestEffort.upstream.body, false);
  });
});
