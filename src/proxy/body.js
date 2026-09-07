import sharp from "sharp";
import { optimizeInlineImage } from "./image-optimizer.js";

const HARD_BLOCKED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "ocp-apim-subscription-key",
  "cookie",
  "set-cookie",
  "content-length",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer"
]);
const CREDENTIAL_HEADER_MARKERS = [
  "authorization",
  "apikey",
  "accesstoken",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "credential"
];
const CREDENTIAL_HEADER_SEGMENTS = new Set([
  "authorization",
  "credential",
  "key",
  "password",
  "secret",
  "token"
]);

const REQUEST_OVERRIDE_FIELD_ALIASES = {
  timeoutMs: "requestMs",
  timeout_ms: "requestMs",
  streamTimeoutMs: "firstByteMs",
  stream_timeout_ms: "firstByteMs",
  idleTimeoutMs: "idleMs",
  idle_timeout_ms: "idleMs",
  maxStreamDurationMs: "maxStreamDurationMs",
  max_stream_duration_ms: "maxStreamDurationMs",
  maxRetries: "maxRetries",
  max_retries: "maxRetries"
};

const DEFAULT_REQUEST_OVERRIDE_LIMITS = {
  requestMs: 900000,
  firstByteMs: 300000,
  idleMs: 900000,
  maxStreamDurationMs: 3600000,
  maxRetries: 2
};

function createPolicyError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function normalizeHeaderList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().toLowerCase())
    : [];
}

function matchesAllowedHeaderPrefix(headerName, prefixes) {
  return prefixes.some((prefix) => headerName.startsWith(prefix));
}

function isBlockedIncomingHeader(headerName) {
  if (HARD_BLOCKED_HEADERS.has(headerName)) return true;
  const compactName = headerName.replace(/[^a-z0-9]/g, "");
  if (CREDENTIAL_HEADER_MARKERS.some((marker) => compactName.includes(marker))) return true;
  return headerName
    .split(/[^a-z0-9]+/)
    .some((segment) => CREDENTIAL_HEADER_SEGMENTS.has(segment));
}

function getForwardHeaderPolicy(config) {
  const policy = config?.proxy?.forwardHeaders || {};
  return {
    mode: policy.mode === "allowlist" ? "allowlist" : "denylist",
    allow: new Set(normalizeHeaderList(policy.allow)),
    deny: new Set(normalizeHeaderList(policy.deny))
  };
}

export function sanitizeIncomingHeaders(headers, config, options = {}) {
  const policy = getForwardHeaderPolicy(config);
  const allowPrefixes = normalizeHeaderList(options.allowPrefixes);
  const denyPrefixes = normalizeHeaderList(options.denyPrefixes);
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (isBlockedIncomingHeader(normalizedKey)) continue;
    if (matchesAllowedHeaderPrefix(normalizedKey, denyPrefixes)) continue;
    if (policy.deny.has(normalizedKey)) continue;
    if (
      policy.mode === "allowlist"
      && !policy.allow.has(normalizedKey)
      && !matchesAllowedHeaderPrefix(normalizedKey, allowPrefixes)
    ) continue;
    filtered[key] = value;
  }
  return filtered;
}

export function sanitizeConfiguredUpstreamHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (HARD_BLOCKED_HEADERS.has(normalizedKey)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    filtered[key] = String(value);
  }
  return filtered;
}

export function getStreamFlag(body) {
  return body?.stream === true;
}

function isMeaninglessValue(value, options = {}) {
  return (
    value === undefined
    || (!options.preserveNull && value === null)
    || value === "[undefined]"
    || value === "undefined"
  );
}

function pruneMeaningless(value, options = {}) {
  if (isMeaninglessValue(value, options)) return undefined;
  if (value === null) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = [];
    for (const item of value) {
      const pruned = pruneMeaningless(item, options);
      if (pruned === undefined) {
        changed = true;
        continue;
      }
      if (pruned !== item) changed = true;
      out.push(pruned);
    }
    return changed ? out : value;
  }
  if (typeof value === "object") {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const pruned = pruneMeaningless(v, options);
      if (pruned === undefined) {
        changed = true;
        continue;
      }
      if (pruned !== v) changed = true;
      out[k] = pruned;
    }
    return changed ? out : value;
  }
  return value;
}

export function sanitizeRequestBody(body, options = {}) {
  if (options.sanitizeMeaninglessValues === false) {
    return body && typeof body === "object" ? body : {};
  }
  const pruned = pruneMeaningless(body, options);
  return pruned && typeof pruned === "object" ? pruned : {};
}

export function extractProxyRequestControls(payload, config) {
  const nextPayload = payload && typeof payload === "object" ? payload : {};
  const allowOverrides = config?.proxy?.timeouts?.allowPerRequestOverride === true;
  const allowedFields = new Set(
    Array.isArray(config?.proxy?.timeouts?.requestOverrideFields)
      ? config.proxy.timeouts.requestOverrideFields.filter((item) => typeof item === "string")
      : []
  );
  const rejectUnknownProxyParams = config?.proxy?.guards?.rejectUnknownProxyParams === true;
  const configuredLimits = config?.proxy?.timeouts?.requestOverrideLimits;
  const overrides = {};
  const rejectedFields = [];

  for (const [field, targetKey] of Object.entries(REQUEST_OVERRIDE_FIELD_ALIASES)) {
    if (!(field in nextPayload)) continue;
    const value = nextPayload[field];
    delete nextPayload[field];

    const fieldAllowed = allowOverrides && (allowedFields.size === 0 || allowedFields.has(field));
    if (!fieldAllowed) {
      if (rejectUnknownProxyParams) {
        rejectedFields.push(field);
      }
      continue;
    }

    const normalizedValue = Number(value);
    if (!Number.isInteger(normalizedValue) || normalizedValue < 0) {
      throw createPolicyError("INVALID_PROXY_CONTROL_FIELD", `${field} must be a non-negative integer`);
    }
    const configuredLimit = configuredLimits?.[targetKey];
    const limit = Number.isInteger(configuredLimit) && configuredLimit >= 0
      ? configuredLimit
      : DEFAULT_REQUEST_OVERRIDE_LIMITS[targetKey];
    if (normalizedValue > limit) {
      throw createPolicyError(
        "PROXY_CONTROL_FIELD_LIMIT_EXCEEDED",
        `${field} must not exceed ${limit}`
      );
    }
    overrides[targetKey] = normalizedValue;
  }

  return {
    body: nextPayload,
    overrides,
    rejectedFields
  };
}

function resolveImageCompression(config) {
  const cfg = config?.media?.inputCompression || config?.server?.imageCompression || {};
  const enabled = cfg.enabled !== false;
  const maxLongSidePx = Number.isFinite(cfg.maxLongSidePx)
    ? cfg.maxLongSidePx
    : (Number.isFinite(cfg.maxSize) ? cfg.maxSize : 1600);
  const minQuality = Number.isFinite(cfg.minQuality) ? Math.min(1, Math.max(0.1, cfg.minQuality)) : 0.1;
  const quality = Number.isFinite(cfg.quality) ? cfg.quality : 0.85;
  const format = cfg.outputFormat === "webp" || cfg.format === "webp" ? "webp" : "jpeg";
  return {
    enabled,
    maxLongSidePx,
    quality: Math.min(1, Math.max(minQuality, quality)),
    format,
    progressive: cfg.progressive === true,
    useMozJpeg: cfg.useMozJpeg !== false
  };
}

function resolveRemoteImagePolicy(config) {
  const cfg = config?.media?.remoteImages || {};
  return {
    allow: cfg.allow === true,
    allowedHosts: Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().toLowerCase()) : []
  };
}

function resolveInlineImagePolicy(config) {
  const cfg = config?.media?.inlineImages || {};
  return {
    maxBase64Bytes: Number.isFinite(cfg.maxBase64Bytes) ? cfg.maxBase64Bytes : 20 * 1024 * 1024
  };
}

function isDataUrlImage(value) {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

function isRemoteImageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function validateRemoteImageUrl(url, policy) {
  if (!isRemoteImageUrl(url)) return;
  if (!policy.allow) {
    throw createPolicyError("REMOTE_IMAGE_URLS_DISABLED", "Remote image_url inputs are disabled by policy");
  }
  if (!policy.allowedHosts.length) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createPolicyError("INVALID_REMOTE_IMAGE_URL", "image_url must be a valid URL");
  }
  if (!policy.allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw createPolicyError("REMOTE_IMAGE_HOST_NOT_ALLOWED", `Remote image host is not allowed: ${parsed.hostname}`);
  }
}

async function compressImageBuffer(buffer, options) {
  let pipeline = sharp(buffer, { failOnError: false });
  try {
    const metadata = await pipeline.metadata();
    if (metadata?.width && metadata?.height && options.maxLongSidePx > 0) {
      const maxSize = options.maxLongSidePx;
      pipeline = pipeline.resize({
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true
      });
    }
  } catch {
    // ignore metadata errors
  }
  const quality = Math.round(options.quality * 100);
  if (options.format === "webp") {
    return {
      buffer: await pipeline.webp({ quality }).toBuffer(),
      mime: "image/webp"
    };
  }
  return {
    buffer: await pipeline.jpeg({ quality, mozjpeg: options.useMozJpeg, progressive: options.progressive }).toBuffer(),
    mime: "image/jpeg"
  };
}

async function compressDataUrl(dataUrl, options, cache) {
  const cached = cache.get(dataUrl);
  if (cached) return cached;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return dataUrl;
  try {
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > options.inlinePolicy.maxBase64Bytes) {
      throw createPolicyError("INLINE_IMAGE_TOO_LARGE", `Inline image payload exceeds ${options.inlinePolicy.maxBase64Bytes} bytes`);
    }
    if (!options.enabled) {
      return dataUrl;
    }
    const out = await compressImageBuffer(buffer, options);
    const result = `data:${out.mime};base64,${out.buffer.toString("base64")}`;
    cache.set(dataUrl, result);
    return result;
  } catch (error) {
    if (error?.code) throw error;
    return dataUrl;
  }
}

async function compressBase64String(base64, options) {
  try {
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > options.inlinePolicy.maxBase64Bytes) {
      throw createPolicyError("INLINE_IMAGE_TOO_LARGE", `Inline image payload exceeds ${options.inlinePolicy.maxBase64Bytes} bytes`);
    }
    if (!options.enabled) {
      return base64;
    }
    const out = await compressImageBuffer(buffer, options);
    return out.buffer.toString("base64");
  } catch (error) {
    if (error?.code) throw error;
    return base64;
  }
}

async function compressImagesInPlace(value, options, cache) {
  if (Array.isArray(value)) {
    for (const item of value) {
      await compressImagesInPlace(item, options, cache);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, raw] of Object.entries(value)) {
    if (key === "image_base64" && typeof raw === "string") {
      value[key] = await compressBase64String(raw, options);
      continue;
    }

    if (key === "image_url") {
      if (typeof raw === "string" && isDataUrlImage(raw)) {
        value[key] = await compressDataUrl(raw, options, cache);
        continue;
      }
      if (typeof raw === "string" && isRemoteImageUrl(raw)) {
        validateRemoteImageUrl(raw, options.remotePolicy);
        continue;
      }
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isDataUrlImage(raw.url)) {
        raw.url = await compressDataUrl(raw.url, options, cache);
        continue;
      }
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isRemoteImageUrl(raw.url)) {
        validateRemoteImageUrl(raw.url, options.remotePolicy);
        continue;
      }
    }

    await compressImagesInPlace(raw, options, cache);
  }
}

function hasCompressibleImage(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasCompressibleImage(item)) return true;
    }
    return false;
  }
  if (!value || typeof value !== "object") return false;

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && key === "image_base64") {
      return true;
    }
    if (key === "image_url") {
      if (typeof raw === "string" && isDataUrlImage(raw)) return true;
      if (typeof raw === "string" && isRemoteImageUrl(raw)) return true;
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isDataUrlImage(raw.url)) return true;
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isRemoteImageUrl(raw.url)) return true;
    }
    if (hasCompressibleImage(raw)) return true;
  }
  return false;
}

function getProtocolImageInputs(payload, routeKey) {
  if (!["chat/completions", "responses", "messages"].includes(routeKey)) return null;
  const inputs = [];
  const visitContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (routeKey === "messages") {
        if (part.type === "tool_result") {
          visitContent(part.content);
        } else if (part.type === "image" && part.source) {
          if (part.source.type === "base64" && typeof part.source.data === "string") {
            inputs.push({ owner: part.source, key: "data", base64: true });
          } else if (part.source.type === "url" && typeof part.source.url === "string") {
            inputs.push({ owner: part.source, key: "url", base64: false });
          }
        }
        continue;
      }
      const imageType = routeKey === "responses" ? "input_image" : "image_url";
      if (part.type !== imageType) continue;
      if (typeof part.image_url === "string") {
        inputs.push({ owner: part, key: "image_url", base64: false });
      } else if (typeof part.image_url?.url === "string") {
        inputs.push({ owner: part.image_url, key: "url", base64: false });
      } else if (routeKey === "responses" && typeof part.file_id === "string") {
        inputs.push({ owner: part, key: "file_id", opaque: true });
      }
    }
  };
  const items = routeKey === "responses" ? payload?.input : payload?.messages;
  for (const item of Array.isArray(items) ? items : []) {
    if (routeKey === "responses" && item?.type === "function_call_output") {
      visitContent(item.output);
    } else if (routeKey !== "responses" || !item?.type || item.type === "message") {
      visitContent(item?.content);
    }
  }
  return inputs;
}

export function validateImageInputs(payload, config, routeKey) {
  const remotePolicy = resolveRemoteImagePolicy(config);
  const inlinePolicy = resolveInlineImagePolicy(config);
  const { maxImages = 0, maxTotalBytes = 0 } = config?.media?.inlineImages || {};
  let imageCount = 0;
  let totalBytes = 0;
  for (const input of getProtocolImageInputs(payload, routeKey) || []) {
    imageCount += 1;
    if (maxImages > 0 && imageCount > maxImages) {
      throw createPolicyError("IMAGE_COUNT_LIMIT_EXCEEDED", `Image count exceeds ${maxImages}`);
    }
    if (input.opaque) continue;
    const value = input.owner[input.key];
    const dataUrl = !input.base64 && value.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]*)$/);
    if (input.base64 || dataUrl) {
      const encoded = input.base64 ? value : dataUrl[1];
      const bytes = Buffer.byteLength(encoded.replace(/\s/g, ""), "base64");
      if (bytes > inlinePolicy.maxBase64Bytes) {
        throw createPolicyError("INLINE_IMAGE_TOO_LARGE", `Inline image payload exceeds ${inlinePolicy.maxBase64Bytes} bytes`);
      }
      totalBytes += bytes;
      if (maxTotalBytes > 0 && totalBytes > maxTotalBytes) {
        throw createPolicyError("INLINE_IMAGES_TOTAL_TOO_LARGE", `Inline image payloads exceed ${maxTotalBytes} bytes in total`);
      }
    } else {
      validateRemoteImageUrl(value, remotePolicy);
    }
  }
}

export async function maybeCompressImages(payload, config, routeKey, context = {}) {
  const options = resolveImageCompression(config);
  options.inlinePolicy = resolveInlineImagePolicy(config);
  options.remotePolicy = resolveRemoteImagePolicy(config);
  const inputs = getProtocolImageInputs(payload, routeKey);
  if (inputs) {
    validateImageInputs(payload, config, routeKey);
    const settings = config?.media?.inputCompression || {};
    if (options.enabled && settings.mode === "adaptive") {
      const cache = new Map();
      const deadline = performance.now() + (settings.timeoutMs ?? 5000);
      for (const input of inputs) {
        if (context.signal?.aborted) {
          throw Object.assign(new Error("client disconnected"), { code: "CLIENT_DISCONNECTED", status: 499 });
        }
        if (input.opaque) continue;
        const original = input.owner[input.key];
        const match = !input.base64 && original.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/);
        const mime = input.base64 ? input.owner.media_type : match?.[1];
        if (mime !== "image/jpeg") {
          context.onImage?.({ reason: mime ? "preserve_format" : "remote_passthrough" });
          continue;
        }
        const encoded = (input.base64 ? original : match[2]).replace(/\s/g, "");
        const inputBytes = Buffer.byteLength(encoded, "base64");
        const remainingMs = deadline - performance.now();
        if (inputBytes < (settings.minBytes ?? 256 * 1024) || remainingMs <= 0) {
          context.onImage?.({ reason: remainingMs <= 0 ? "timeout" : "below_threshold", inputBytes, outputBytes: inputBytes });
          continue;
        }
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
          context.onImage?.({ reason: "invalid_encoding", inputBytes, outputBytes: inputBytes });
          continue;
        }
        let optimized = cache.get(encoded);
        if (!optimized) {
          optimized = await optimizeInlineImage(Buffer.from(encoded, "base64"), settings, { signal: context.signal, remainingMs });
          cache.set(encoded, optimized);
          const { buffer, ...metadata } = optimized;
          context.onImage?.(metadata);
        }
        if (optimized.reason !== "optimized") continue;
        const output = optimized.buffer.toString("base64");
        input.owner[input.key] = input.base64 ? output : `data:image/jpeg;base64,${output}`;
      }
      return payload;
    }
    if (settings.mode === "preserve") return payload;
    if (routeKey === "messages" || !options.enabled) return payload;
    const cache = new Map();
    for (const input of inputs) {
      if (input.opaque) continue;
      const value = input.owner[input.key];
      if (isDataUrlImage(value)) {
        input.owner[input.key] = await compressDataUrl(value, options, cache);
      }
    }
    return payload;
  }
  if (["adaptive", "preserve"].includes(config?.media?.inputCompression?.mode)) return payload;
  if (!hasCompressibleImage(payload)) {
    return payload;
  }
  const cache = new Map();
  await compressImagesInPlace(payload, options, cache);
  return payload;
}
