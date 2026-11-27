const trustedErrors = new WeakSet();
const maxBytes = 32 * 1024;

export function fail(code) {
  const error = new Error(code);
  error.code = code;
  trustedErrors.add(error);
  throw Object.freeze(error);
}

export function sanitize(error, fallback = "CREDENTIAL_STORE_UNAVAILABLE") {
  if (trustedErrors.has(error)) throw error;
  fail(fallback);
}

export function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateSecrets(secrets) {
  const plain = v => v !== null && typeof v === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(v));
  if (!plain(secrets) || !Object.keys(secrets).length) throw new Error();
  let budget = maxBytes;
  function visit(v, depth) {
    if (--budget < 0 || depth > 32) throw new Error();
    if (typeof v === "string") {
      budget -= Buffer.byteLength(v);
      if (budget < 0) throw new Error();
      return v;
    }
    if (v === null || typeof v === "boolean" || Number.isFinite(v)) return v;
    if (!Array.isArray(v) && !plain(v)) throw new Error();
    const keys = Object.keys(v);
    if (keys.length > budget || (Array.isArray(v) && v.length !== keys.length)) throw new Error();
    const copy = Array.isArray(v) ? [] : Object.create(null);
    for (const [i, k] of keys.entries()) {
      const property = Object.getOwnPropertyDescriptor(v, k);
      if (!Object.hasOwn(property, "value") || (Array.isArray(v) && String(i) !== k)) throw new Error();
      budget -= Buffer.byteLength(k);
      copy[k] = visit(property.value, depth + 1);
    }
    return copy;
  }
  const json = JSON.stringify(visit(secrets, 0));
  if (Buffer.byteLength(json) > maxBytes) throw new Error();
  return JSON.parse(json);
}

export function makeCredentialRecord(ref, secrets) {
  try {
    return { format: "plaintext-v1", ref, secrets: validateSecrets(secrets) };
  } catch (error) {
    sanitize(error, "CREDENTIAL_PAYLOAD_INVALID");
  }
}

export function readCredentialRecord(record) {
  if (record?.envelope && record.format === undefined) fail("CREDENTIAL_LEGACY_ENCRYPTION_UNSUPPORTED");
  if (record?.format !== "plaintext-v1") fail("CREDENTIAL_STORE_UNAVAILABLE");
  try {
    return validateSecrets(record.secrets);
  } catch (error) {
    sanitize(error);
  }
}
