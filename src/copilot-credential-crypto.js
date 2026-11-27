import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const trustedErrors = new WeakSet();
const maxBytes = 32 * 1024;
const keyVersion = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

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

function decode(text, length) {
  if (typeof text !== "string" || text.length > 4 * Math.ceil(maxBytes / 3)) throw new Error();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > maxBytes || (length != null && bytes.length !== length) || bytes.toString("base64") !== text) throw new Error();
  return bytes;
}

export function credentialKeyringFromEnv(env = process.env) {
  try {
    const activeVersion = env.COPILOT_CREDENTIAL_KEY_VERSION;
    const raw = env.COPILOT_CREDENTIAL_KEYS;
    if (typeof raw !== "string" || raw.length > 8192) throw new Error();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const keys = Object.fromEntries(Object.entries(parsed).map(([v, value]) => [v, decode(value, 32)]));
    validateKeys({ activeVersion, keys });
    return { activeVersion, keys };
  } catch {
    fail("CREDENTIAL_KEY_UNAVAILABLE");
  }
}

function validateKeys({ activeVersion, keys }) {
  if (typeof activeVersion !== "string" || !keyVersion.test(activeVersion) || !keys || !Object.hasOwn(keys, activeVersion)
    || Object.keys(keys).length > 32 || !Object.entries(keys).every(([v, k]) => keyVersion.test(v) && Buffer.isBuffer(k) && k.length === 32)) {
    throw new Error();
  }
}

function encodeSecrets(secrets) {
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
  return Buffer.from(json);
}

export function makeCipher(keyring, namespace) {
  let version, keys;
  try {
    validateKeys(keyring);
    version = keyring.activeVersion;
    keys = new Map(Object.entries(keyring.keys).map(([v, k]) => [v, Buffer.from(k)]));
  } catch {
    fail("CREDENTIAL_KEY_UNAVAILABLE");
  }
  const aad = (binding, reference, purpose, generation, credentialVersion, v) => Buffer.from(JSON.stringify([
    "aoai.copilot.credentials.v1", namespace, binding.channelId, binding.principalId, binding.profile,
    reference, purpose, generation, credentialVersion, v
  ]));
  return {
    seal(binding, reference, purpose, generation, credentialVersion, secrets) {
      let plaintext;
      try {
        plaintext = encodeSecrets(secrets);
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", keys.get(version), nonce);
        cipher.setAAD(aad(binding, reference, purpose, generation, credentialVersion, version));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return { version, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      } catch {
        fail("CREDENTIAL_PAYLOAD_INVALID");
      } finally {
        plaintext?.fill(0);
      }
    },
    unseal(binding, reference, purpose, generation, credentialVersion, envelope) {
      let decrypted, plaintext;
      try {
        const { version: v, nonce, tag, ciphertext } = envelope;
        if (!keys.has(v)) fail("CREDENTIAL_KEY_UNAVAILABLE");
        const cipher = createDecipheriv("aes-256-gcm", keys.get(v), decode(nonce, 12), { authTagLength: 16 });
        cipher.setAAD(aad(binding, reference, purpose, generation, credentialVersion, v));
        cipher.setAuthTag(decode(tag, 16));
        decrypted = cipher.update(decode(ciphertext));
        cipher.final();
        plaintext = JSON.parse(decrypted.toString("utf8"));
        return plaintext;
      } catch (error) {
        sanitize(error, "CREDENTIAL_DECRYPT_FAILED");
      } finally {
        decrypted?.fill(0);
      }
    },
    destroy() { for (const key of keys.values()) key.fill(0); }
  };
}
