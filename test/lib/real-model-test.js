import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "test/output");

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function getOptionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getConfig() {
  return {
    baseUrl: getOptionalEnv("AOAI_PROXY_REAL_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: requireEnv("AOAI_PROXY_REAL_API_KEY"),
    outputDir: path.resolve(getOptionalEnv("AOAI_PROXY_REAL_OUTPUT_DIR", DEFAULT_OUTPUT_DIR)),
    timeoutMs: Number(getOptionalEnv("AOAI_PROXY_REAL_TIMEOUT_MS", "180000")) || 180000
  };
}

function createHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json"
  };
}

async function requestJson(routePath, payload) {
  const config = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}${routePath}`, {
      method: "POST",
      headers: createHeaders(config.apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    assert.equal(response.status, 200, text || `Unexpected status ${response.status}`);
    return { response, text, json, config };
  } finally {
    clearTimeout(timer);
  }
}

function extractOutputText(payload) {
  const chatText = payload?.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.trim()) {
    return chatText.trim();
  }

  const outputItems = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of outputItems) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
      if (typeof part?.output_text === "string" && part.output_text.trim()) {
        return part.output_text.trim();
      }
    }
  }

  return "";
}

function extractImageAsset(payload) {
  const dataItem = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (dataItem?.b64_json) {
    return { type: "b64_json", value: dataItem.b64_json };
  }
  if (dataItem?.url) {
    return { type: "url", value: dataItem.url };
  }
  if (typeof payload?.url === "string" && payload.url.trim()) {
    return { type: "url", value: payload.url.trim() };
  }
  if (typeof payload?.image === "string" && payload.image.trim()) {
    return { type: "url", value: payload.image.trim() };
  }
  return null;
}

async function saveBase64Image(outputDir, filePrefix, base64Data) {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${filePrefix}-${Date.now()}.png`);
  await fs.writeFile(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

export async function runRealChatCompletionTest() {
  const model = requireEnv("AOAI_PROXY_REAL_CHAT_MODEL");
  const result = await requestJson("/v1/chat/completions", {
    model,
    messages: [
      {
        role: "system",
        content: "Reply in one short sentence."
      },
      {
        role: "user",
        content: "Say hello and mention this is a route test."
      }
    ]
  });

  const text = extractOutputText(result.json);
  assert.ok(text, `Expected assistant text in response: ${result.text}`);
  process.stdout.write(`PASS real chat-completion model=${model}\n${text}\n`);
}

export async function runRealResponseTest() {
  const model = requireEnv("AOAI_PROXY_REAL_RESPONSE_MODEL");
  const result = await requestJson("/v1/responses", {
    model,
    input: "Reply in one short sentence and mention this is a route test."
  });

  const text = extractOutputText(result.json);
  assert.ok(text, `Expected output text in response payload: ${result.text}`);
  process.stdout.write(`PASS real response model=${model}\n${text}\n`);
}

export async function runRealOpenAiImageTest() {
  const model = requireEnv("AOAI_PROXY_REAL_OPENAI_IMAGE_MODEL");
  const result = await requestJson("/v1/images/generations", {
    model,
    prompt: "Generate a simple route test image with the words AOAI Proxy.",
    size: getOptionalEnv("AOAI_PROXY_REAL_OPENAI_IMAGE_SIZE", "1024x1024"),
    quality: getOptionalEnv("AOAI_PROXY_REAL_OPENAI_IMAGE_QUALITY", "standard")
  });

  const asset = extractImageAsset(result.json);
  assert.ok(asset, `Expected image asset in response payload: ${result.text}`);

  if (asset.type === "b64_json") {
    const filePath = await saveBase64Image(result.config.outputDir, "openai-image", asset.value);
    process.stdout.write(`PASS real openai-image model=${model}\nSaved image: ${filePath}\n`);
    return;
  }

  process.stdout.write(`PASS real openai-image model=${model}\nImage URL: ${asset.value}\n`);
}

export async function runRealBlackforestImageTest() {
  const model = requireEnv("AOAI_PROXY_REAL_BLACKFOREST_IMAGE_MODEL");
  const result = await requestJson("/v1/images/generations", {
    model,
    prompt: "Generate a simple forest-themed route test image with bold shapes.",
    size: getOptionalEnv("AOAI_PROXY_REAL_BLACKFOREST_IMAGE_SIZE", "1024x1024")
  });

  const asset = extractImageAsset(result.json);
  assert.ok(asset, `Expected image asset in response payload: ${result.text}`);

  if (asset.type === "b64_json") {
    const filePath = await saveBase64Image(result.config.outputDir, "blackforest-image", asset.value);
    process.stdout.write(`PASS real blackforest-image model=${model}\nSaved image: ${filePath}\n`);
    return;
  }

  process.stdout.write(`PASS real blackforest-image model=${model}\nImage URL: ${asset.value}\n`);
}