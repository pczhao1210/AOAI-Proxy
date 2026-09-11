export const DEFAULT_MEDIA_HTTP = Object.freeze({
  enabled: false,
  maxUploadBytes: 25 * 1024 * 1024,
  maxResponseBytes: 100 * 1024 * 1024,
  maxFiles: 10,
  maxFields: 64,
  maxFieldBytes: 64 * 1024,
  maxConcurrentUploads: 4,
  maxBufferedUploadBytes: 300 * 1024 * 1024,
  uploadTimeoutMs: 60000
});

let activeUploads = 0;
let reservedBytes = 0;

export function getMediaHttpLimits(config) {
  const settings = config?.media?.http || {};
  return Object.fromEntries(Object.entries(DEFAULT_MEDIA_HTTP).map(([name, fallback]) => [name,
    name === "enabled" ? settings.enabled === true
      : Number.isSafeInteger(settings[name]) && settings[name] > 0 ? settings[name] : fallback]));
}

function uploadError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function reserveMediaBuffer(config, reservation) {
  const limits = getMediaHttpLimits(config);
  if (!Number.isSafeInteger(reservation) || reservation <= 0 || activeUploads >= limits.maxConcurrentUploads
    || reservedBytes + reservation > limits.maxBufferedUploadBytes) {
    throw uploadError(429, "UPLOAD_CAPACITY_EXCEEDED", "Media upload capacity is exhausted");
  }
  activeUploads += 1;
  reservedBytes += reservation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
    reservedBytes -= reservation;
  };
}

export async function readMediaMultipart(req, config, { requireModel = true } = {}) {
  const limits = getMediaHttpLimits(config);
  const release = reserveMediaBuffer(config, limits.maxUploadBytes * 3);
  const timer = setTimeout(() => req.raw.destroy(uploadError(408, "UPLOAD_TIMEOUT", "Media upload timed out")), limits.uploadTimeoutMs);
  const fields = Object.create(null);
  const parts = [];
  let bytes = 0;
  let fileCount = 0;
  let fieldCount = 0;
  try {
    for await (const part of req.parts({
      isPartAFile: (name, contentType, filename) => filename !== undefined
        || contentType === "application/octet-stream" || contentType.startsWith("application/json"),
      limits: { fileSize: limits.maxUploadBytes, files: limits.maxFiles + limits.maxFields,
        fields: limits.maxFields, fieldSize: limits.maxFieldBytes, fieldNameSize: 256, parts: limits.maxFiles + limits.maxFields }
    })) {
      const jsonField = part.type === "file" && part.filename === undefined && part.mimetype.startsWith("application/json");
      const isFile = part.type === "file" && !jsonField;
      if (isFile) fileCount += 1;
      else fieldCount += 1;
      if (fileCount > limits.maxFiles || fieldCount > limits.maxFields) {
        throw uploadError(413, "UPLOAD_PART_LIMIT", "Media upload exceeded its file or field limit");
      }
      if (part.fieldname === "model" && (isFile || Object.hasOwn(fields, "model"))) {
        throw uploadError(400, "AMBIGUOUS_MODEL", "Exactly one model field is required");
      }
      if (part.type === "file") {
        const chunks = [];
        let partBytes = 0;
        for await (const chunk of part.file) {
          bytes += chunk.length;
          partBytes += chunk.length;
          if (jsonField && partBytes > limits.maxFieldBytes) throw uploadError(413, "UPLOAD_FIELD_TOO_LARGE", "Media field exceeded its byte limit");
          if (bytes > limits.maxUploadBytes) throw uploadError(413, "UPLOAD_TOO_LARGE", "Media upload exceeded its byte limit");
          chunks.push(chunk);
        }
        if (part.file.truncated) throw uploadError(413, "UPLOAD_TOO_LARGE", "Media file exceeded its byte limit");
        if (jsonField) {
          const value = Buffer.concat(chunks).toString("utf8");
          parts.push({ name: part.fieldname, value });
          fields[part.fieldname] = value;
        } else {
          const file = new Blob(chunks, { type: part.mimetype });
          parts.push({ name: part.fieldname, file, filename: part.filename });
          fields[part.fieldname] = true;
        }
      } else {
        if (part.fieldnameTruncated || part.valueTruncated) throw uploadError(413, "UPLOAD_FIELD_TOO_LARGE", "Media field exceeded its byte limit");
        const value = typeof part.value === "string" ? part.value : JSON.stringify(part.value);
        bytes += Buffer.byteLength(value);
        if (bytes > limits.maxUploadBytes) throw uploadError(413, "UPLOAD_TOO_LARGE", "Media upload exceeded its byte limit");
        parts.push({ name: part.fieldname, value });
        fields[part.fieldname] = value;
      }
    }
    if (requireModel && (typeof fields.model !== "string" || !fields.model)) throw uploadError(400, "MODEL_REQUIRED", "A public model is required");
    return { fields, parts, bytes, release };
  } catch (error) {
    release();
    if (error.code?.startsWith("FST_")) {
      throw uploadError(error.statusCode || 400, error.code, "Invalid or oversized multipart upload");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function buildMediaMultipart(upload, fields) {
  const form = new FormData();
  const seen = new Set();
  for (const part of upload.parts) {
    seen.add(part.name);
    if (!Object.hasOwn(fields, part.name)) continue;
    if (part.file) form.append(part.name, part.file, part.filename);
    else form.append(part.name, part.name === "model" ? fields.model : part.value);
  }
  for (const [name, value] of Object.entries(fields)) {
    if (!seen.has(name)) form.append(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  return form;
}