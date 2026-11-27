import { randomBytes } from "node:crypto";
import { makeCredentialRecord, readCredentialRecord, fail, identifier, sanitize } from "./copilot-credential-record.js";
import { fileBackend, postgresBackend } from "./copilot-credential-backends.js";

const counter = n => Number.isSafeInteger(n) && n >= 0;
const increment = n => {
  if (!counter(n + 1)) fail("CREDENTIAL_STORE_UNAVAILABLE");
  return n + 1;
};
const isRef = ref => typeof ref === "string" && /^[A-Za-z0-9_-]{43}$/.test(ref);

function bindingOf(input) {
  const { channelId, principalId, profile } = input ?? {};
  if (!identifier(channelId) || !identifier(principalId) || !["vscode", "opencode"].includes(profile)) fail("CREDENTIAL_INPUT_INVALID");
  return { channelId, principalId, profile };
}

function bound(binding, row) {
  if (row === null) return { principalId: binding.principalId, profile: binding.profile,
    generation: 0, credentialVersion: 0, fence: 0, active: null, prepared: null, lease: null };
  if (row.principalId !== binding.principalId || row.profile !== binding.profile) fail("CREDENTIAL_BINDING_MISMATCH");
  if (![row.generation, row.credentialVersion, row.fence].every(counter)
    || ![row.active, row.prepared].every(item => item === null || (isRef(item?.ref)
      && ((item.format === "plaintext-v1" && Object.hasOwn(item, "secrets"))
        || (item.format === undefined && item.envelope && typeof item.envelope === "object"))))
    || !(row.lease === null || (typeof row.lease?.rotating === "boolean" && counter(row.lease.until)
      && row.active && row.lease.fence === row.fence))) fail("CREDENTIAL_STORE_UNAVAILABLE");
  return row;
}

function meta(row) {
  const state = row.active ? "active" : row.prepared ? "prepared" : row.generation ? "revoked" : "empty";
  return { state, generation: row.generation, credentialVersion: row.credentialVersion,
    credentialRef: row.active?.ref ?? row.prepared?.ref ?? null, preparedRef: row.prepared?.ref ?? null,
    rotationPending: row.lease?.rotating === true };
}

function withSecrets(metadata, secrets) {
  // Logging/spreading the wrapper must not serialize the private payload.
  return Object.defineProperty(metadata, "secrets", { value: secrets, enumerable: false });
}

function match(row, generation, version) {
  if (row.generation !== generation || (version !== undefined && row.credentialVersion !== version)) fail("CREDENTIAL_CONFLICT");
}

function active(row, ref) {
  if (!isRef(ref) || row.active?.ref !== ref) fail("CREDENTIAL_NOT_ACTIVE");
}

function candidateOrActive(row, ref) {
  if (isRef(ref) && row.prepared?.ref === ref) return "prepared";
  active(row, ref);
  return "active";
}

async function open(options, backend) {
  try {
    return store(await backend(options));
  } catch (error) {
    sanitize(error);
  }
}

export const openFileCredentialStore = options => open(options, fileBackend);
export const openPostgresCredentialStore = options => open(options, postgresBackend);

function store(db) {
  const pending = new Set(), flights = new Map(), controllers = new Set();
  let closing = false, closePromise;
  function checkOpen() { if (closing) fail("CREDENTIAL_STORE_CLOSED"); }
  function run(fn) {
    const promise = (async () => {
      try { checkOpen(); return await fn(); } catch (error) { sanitize(error); }
    })();
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  async function get(binding) { return bound(binding, await db.get(binding.channelId)); }
  function change(binding, transform) {
    return db.change(binding.channelId, (record, now) => {
      checkOpen();
      return transform(bound(binding, record), now);
    });
  }
  function read(row, kind) {
    return readCredentialRecord(row[kind]);
  }
  async function resolve(config, checkPayload) {
    const { channelId, authProfile, credentialRef } = config ?? {};
    if (!identifier(channelId) || !isRef(credentialRef)) fail("CREDENTIAL_INPUT_INVALID");
    const row = await db.get(channelId);
    if (!row || row.profile !== authProfile) fail("CREDENTIAL_BINDING_MISMATCH");
    const binding = bindingOf({ channelId, profile: authProfile, principalId: row.principalId });
    const kind = candidateOrActive(bound(binding, row), credentialRef);
    if (checkPayload) read(row, kind);
    return binding;
  }
  function marked(row) { return { next: row, result: meta(row) }; }

  async function refreshOnce(binding, ref, observed, renew, { leaseMs, rotating }) {
    const claim = await change(binding, (row, now) => {
      active(row, ref);
      match(row, observed.generation, observed.credentialVersion);
      if (row.lease?.rotating) fail("CREDENTIAL_ROTATION_PENDING");
      if (row.lease && row.lease.until > now) fail("CREDENTIAL_LEASE_BUSY");
      const secrets = read(row, "active");
      row.fence = increment(row.fence);
      row.lease = { fence: row.fence, until: now + leaseMs, rotating };
      return { next: row, result: { fence: row.fence, secrets } };
    });
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), leaseMs);
    let committed = false;
    try {
      checkOpen();
      const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(), { once: true }));
      let updated;
      try {
        updated = await Promise.race([aborted, renew(claim.secrets, { signal: controller.signal })]);
      } catch {
        checkOpen();
        fail(controller.signal.aborted ? "CREDENTIAL_REFRESH_TIMEOUT" : "CREDENTIAL_REFRESH_FAILED");
      }
      const result = await change(binding, (row, now) => {
        active(row, ref);
        match(row, observed.generation, observed.credentialVersion);
        if (row.lease?.fence !== claim.fence || row.lease.until <= now) fail("CREDENTIAL_CONFLICT");
        const deadline = row.lease.until;
        row.credentialVersion = increment(row.credentialVersion);
        row.active = makeCredentialRecord(ref, updated);
        row.lease = null;
        return { ...marked(row), deadline };
      });
      committed = true;
      return result;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      // One-use remote rotation cannot be safely retried after an ambiguous failure.
      // Its persisted barrier survives a crash; fresh login or revocation clears it.
      if (!committed && !rotating) {
        try {
          await db.change(binding.channelId, record => {
            const row = bound(binding, record);
            if (row.lease?.fence !== claim.fence) return {};
            row.lease = null;
            return { next: row };
          });
        } catch {
          // Leave the authoritative lease alone; only the storage clock can expire it.
          fail("CREDENTIAL_LEASE_RELEASE_FAILED");
        }
      }
    }
  }
  function activateMany(items) {
    return run(() => {
      const steps = items.map(({ binding: input, credentialRef: ref, generation }) => {
        const binding = bindingOf(input);
        return { channel: binding.channelId, mutate(record) {
          checkOpen();
          const row = bound(binding, record);
          const kind = candidateOrActive(row, ref);
          const secrets = read(row, kind);
          if (kind === "active") return { result: meta(row) };
          match(row, generation);
          row.generation = increment(row.generation);
          row.credentialVersion = increment(row.credentialVersion);
          row.active = makeCredentialRecord(ref, secrets);
          row.prepared = row.lease = null;
          return marked(row);
        } };
      });
      steps.sort((a, b) => a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0);
      return db.changeMany(steps);
    });
  }
  return Object.freeze({
    status(input) {
      return run(async () => meta(await get(bindingOf(input))));
    },
    prepare(input, secrets, expectedGeneration) {
      return run(() => {
        const binding = bindingOf(input);
        return change(binding, row => {
          match(row, expectedGeneration);
          if (row.prepared) fail("CREDENTIAL_PREPARED_EXISTS");
          const ref = randomBytes(32).toString("base64url");
          row.prepared = makeCredentialRecord(ref, secrets);
          return { next: row, result: { credentialRef: ref, generation: row.generation } };
        });
      });
    },
    inspect(input, ref) {
      return run(async () => {
        const binding = bindingOf(input), row = await get(binding);
        const kind = candidateOrActive(row, ref);
        read(row, kind);
        return { ...meta(row), state: kind, credentialRef: ref };
      });
    },
    readForManagement(input, ref) {
      return run(async () => {
        const binding = bindingOf(input), row = await get(binding);
        const kind = candidateOrActive(row, ref);
        if (kind === "active" && row.lease?.rotating) fail("CREDENTIAL_ROTATION_PENDING");
        return withSecrets({ ...meta(row), state: kind, credentialRef: ref }, read(row, kind));
      });
    },
    resolveBinding(config) {
      return run(() => resolve(config, true));
    },
    resolveIdentity(config) {
      return run(() => resolve(config, false));
    },
    activateMany,
    async activate(binding, credentialRef, generation) {
      return (await activateMany([{ binding, credentialRef, generation }]))[0];
    },
    discardPrepared(input, ref, expectedGeneration) {
      return run(() => change(bindingOf(input), row => {
        match(row, expectedGeneration);
        if (!isRef(ref) || row.prepared?.ref !== ref) fail("CREDENTIAL_CONFLICT");
        row.prepared = null;
        return marked(row);
      }));
    },
    admit(input, ref) {
      return run(async () => {
        const binding = bindingOf(input), row = await get(binding);
        active(row, ref);
        if (row.lease?.rotating) fail("CREDENTIAL_ROTATION_PENDING");
        return withSecrets(meta(row), read(row, "active"));
      });
    },
    refresh(input, ref, renew, options) {
      return run(async () => {
        const { leaseMs = 30_000, rotating = false, expectedCredentialVersion } = options ?? {};
        if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000 || typeof renew !== "function" || typeof rotating !== "boolean") {
          fail("CREDENTIAL_INPUT_INVALID");
        }
        const binding = bindingOf(input), observed = await get(binding);
        active(observed, ref);
        match(observed, observed.generation, expectedCredentialVersion);
        const key = JSON.stringify([binding.channelId, ref, observed.generation, observed.credentialVersion]);
        if (!flights.has(key)) {
          const work = refreshOnce(binding, ref, observed, renew, { leaseMs, rotating }).finally(() => flights.delete(key));
          flights.set(key, work);
        }
        return flights.get(key);
      });
    },
    revoke(input, expectedGeneration, expectedCredentialVersion) {
      return run(() => change(bindingOf(input), row => {
        match(row, expectedGeneration, expectedCredentialVersion);
        row.generation = increment(row.generation);
        row.credentialVersion = increment(row.credentialVersion);
        row.active = row.prepared = row.lease = null;
        return marked(row);
      }));
    },
    close() {
      if (!closePromise) {
        closing = true;
        for (const controller of controllers) controller.abort();
        closePromise = (async () => {
          await Promise.allSettled([...pending]);
          try { await db.close(); } catch (error) { sanitize(error); }
        })();
      }
      return closePromise;
    }
  });
}
