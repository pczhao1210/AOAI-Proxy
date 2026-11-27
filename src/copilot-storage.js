import { openFileCredentialStore, openPostgresCredentialStore } from "./copilot-credentials.js";
import { copilotError } from "./copilot-provider.js";
import { getChannelCredentialStorage } from "./persistence.js";

function providerError(error) {
  if (error?.code?.startsWith("COPILOT_")) return error;
  const unavailable = ["CREDENTIAL_NOT_ACTIVE", "CREDENTIAL_ROTATION_PENDING"];
  if (unavailable.includes(error?.code)) return copilotError("COPILOT_AUTH_REQUIRED", 409);
  if (error?.code === "CREDENTIAL_BINDING_MISMATCH") return copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
  if (error?.code === "CREDENTIAL_PREPARED_EXISTS") return copilotError("COPILOT_CANDIDATE_EXISTS", 409);
  if (error?.code === "CREDENTIAL_LEGACY_ENCRYPTION_UNSUPPORTED") return copilotError("COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED", 409);
  return copilotError("COPILOT_STATE_UNAVAILABLE", 503);
}

export function credentialAdapter(raw) {
  const binding = ref => raw.resolveBinding({ ...ref, authProfile: ref.profile });
  const identity = ref => raw.resolveIdentity({ ...ref, authProfile: ref.profile });
  const methods = {
    async identity(ref) {
      return { subject: (await identity(ref)).principalId };
    },
    async prepare(ref, secrets) {
      const b = { ...ref, principalId: ref.subject };
      const meta = await raw.status(b);
      return { ...ref, ...await raw.prepare(b, secrets, meta.generation) };
    },
    async read(ref, management = false) {
      const b = await binding(ref);
      const row = await raw[management ? "readForManagement" : "admit"](b, ref.credentialRef);
      return Object.assign(row, { subject: b.principalId });
    },
    async activateMany(items) {
      return raw.activateMany(await Promise.all(items.map(async ({ ref, generation }) => ({
        binding: await binding(ref), credentialRef: ref.credentialRef, generation
      }))));
    },
    async refresh(ref, row, renew, rotating) {
      const b = await binding(ref);
      let fault;
      try {
        await raw.refresh(b, ref.credentialRef, async (_previous, { signal }) => {
          try { return await renew(signal); } catch (error) { fault = error; throw error; }
        }, { leaseMs: 45000, rotating, expectedCredentialVersion: row.credentialVersion });
      } catch (error) {
        if (error.code === "CREDENTIAL_CONFLICT") {
          const current = await methods.read(ref);
          if (current.credentialVersion !== row.credentialVersion) return current;
        }
        throw fault || error;
      }
      return methods.read(ref);
    },
    async invalidate(ref, row, revoked = false) {
      const b = await binding(ref);
      if (revoked || (ref.profile === "opencode" && !row.secrets.oauth.refreshToken)) {
        return raw.revoke(b, row.generation, row.credentialVersion);
      }
      return raw.refresh(b, ref.credentialRef, async secrets => ({ ...secrets, inference: null,
        oauth: ref.profile === "opencode" ? { ...secrets.oauth, expiresAt: 1 } : secrets.oauth
      }), { expectedCredentialVersion: row.credentialVersion });
    },
    async discard(ref) {
      return raw.discardPrepared(await identity(ref), ref.credentialRef, ref.generation);
    },
    async disconnect(ref) {
      const b = await identity(ref);
      const row = await raw.status(b);
      if (row.credentialRef !== ref.credentialRef && row.preparedRef !== ref.credentialRef) {
        throw copilotError("COPILOT_AUTH_REQUIRED", 409);
      }
      return row.preparedRef === ref.credentialRef ? raw.discardPrepared(b, ref.credentialRef, row.generation)
        : raw.revoke(b, row.generation, row.credentialVersion);
    },
    close: () => raw.close()
  };
  return Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => {
    try { return await fn(...args); } catch (error) { throw providerError(error); }
  }]));
}

let opening;
export async function channelCredentialStore(config) {
  if (!opening) {
    opening = (async () => {
      const settings = getChannelCredentialStorage(config);
      const raw = settings.pool ? await openPostgresCredentialStore(settings)
        : await openFileCredentialStore({ directory: process.env.COPILOT_CREDENTIAL_DIRECTORY || settings.path });
      return credentialAdapter(raw);
    })().catch(error => { opening = null; throw providerError(error); });
  }
  return opening;
}

export async function closeChannelCredentials() {
  if (opening) await (await opening).close();
  opening = null;
}
