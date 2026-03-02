import sharp from "sharp";

export function sanitizeIncomingHeaders(headers) {
  const blocked = new Set([
    "authorization",
    "x-api-key",
    "api-key",
    "ocp-apim-subscription-key",
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
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function getStreamFlag(body) {
  return body?.stream === true;
}

function isMeaninglessValue(value) {
  return (
    value === undefined
    || value === null
    || value === "[undefined]"
    || value === "undefined"
  );
}

function pruneMeaningless(value) {
  if (isMeaninglessValue(value)) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => pruneMeaningless(v)).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const pruned = pruneMeaningless(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return out;
  }
  return value;
}

export function sanitizeRequestBody(body) {
  const pruned = pruneMeaningless(body);
  return pruned && typeof pruned === "object" ? pruned : {};
}

function resolveImageCompression(config) {
  const cfg = config?.server?.imageCompression || {};
  const enabled = cfg.enabled !== false;
  const maxSize = Number.isFinite(cfg.maxSize) ? cfg.maxSize : 1600;
  const quality = Number.isFinite(cfg.quality) ? cfg.quality : 0.85;
  const format = cfg.format === "webp" ? "webp" : "jpeg";
  return {
    enabled,
    maxSize,
    quality: Math.min(1, Math.max(0.1, quality)),
    format
  };
}

function isDataUrlImage(value) {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

async function compressImageBuffer(buffer, options) {
  let pipeline = sharp(buffer, { failOnError: false });
  try {
    const metadata = await pipeline.metadata();
    if (metadata?.width && metadata?.height && options.maxSize > 0) {
      const maxSize = options.maxSize;
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
    buffer: await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer(),
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
    const out = await compressImageBuffer(buffer, options);
    const result = `data:${out.mime};base64,${out.buffer.toString("base64")}`;
    cache.set(dataUrl, result);
    return result;
  } catch {
    return dataUrl;
  }
}

async function compressBase64String(base64, options) {
  try {
    const buffer = Buffer.from(base64, "base64");
    const out = await compressImageBuffer(buffer, options);
    return out.buffer.toString("base64");
  } catch {
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
    if (typeof raw === "string") {
      if (key === "image_base64") {
        value[key] = await compressBase64String(raw, options);
        continue;
      }
      if (isDataUrlImage(raw)) {
        value[key] = await compressDataUrl(raw, options, cache);
        continue;
      }
    }

    if (key === "image_url") {
      if (typeof raw === "string" && isDataUrlImage(raw)) {
        value[key] = await compressDataUrl(raw, options, cache);
        continue;
      }
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isDataUrlImage(raw.url)) {
        raw.url = await compressDataUrl(raw.url, options, cache);
        continue;
      }
    }

    await compressImagesInPlace(raw, options, cache);
  }
}

function hasCompressibleImage(value) {
  if (typeof value === "string") {
    return isDataUrlImage(value);
  }
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
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isDataUrlImage(raw.url)) return true;
    }
    if (hasCompressibleImage(raw)) return true;
  }
  return false;
}

export async function maybeCompressImages(payload, config, routeKey) {
  const options = resolveImageCompression(config);
  if (!options.enabled) return payload;
  if (routeKey !== "images/generations" && !hasCompressibleImage(payload)) {
    return payload;
  }
  const cache = new Map();
  await compressImagesInPlace(payload, options, cache);
  return payload;
}
