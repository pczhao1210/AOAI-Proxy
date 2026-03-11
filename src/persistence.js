import fs from "node:fs/promises";
import path from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { appendStructuredLog } from "./logs.js";

const DEFAULT_PERSISTENCE_MODE = "azureFile";
const DEFAULT_CONFIG_BLOB_NAME = "config/config.json";
const DEFAULT_BLOB_RECOVERY_INTERVAL_MS = 30000;

let blobServiceClient = null;
let blobCredential = null;
let blobRecoveryTimer = null;
let blobRecoveryRunning = false;

const persistenceState = {
  configuredMode: DEFAULT_PERSISTENCE_MODE,
  activeMode: DEFAULT_PERSISTENCE_MODE,
  blobAccessState: "disabled",
  pendingBlobSync: false,
  lastBlobError: null
};

function normalizeMode(mode) {
  return mode === "blob" ? "blob" : DEFAULT_PERSISTENCE_MODE;
}

function getBlobRecoveryIntervalMs() {
  const envValue = Number(process.env.BLOB_RECOVERY_INTERVAL_MS);
  return Number.isFinite(envValue) && envValue >= 1000 ? envValue : DEFAULT_BLOB_RECOVERY_INTERVAL_MS;
}

function emitPersistenceEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields
  };
  appendStructuredLog(level, payload);
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logger(JSON.stringify(payload));
}

function updatePersistenceState(patch) {
  Object.assign(persistenceState, patch);
}

function isBlobAuthorizationError(error) {
  return error?.statusCode === 403 || error?.details?.errorCode === "AuthorizationPermissionMismatch" || error?.code === "AuthorizationPermissionMismatch";
}

function snapshotBlobError(error) {
  if (!error) return null;
  return {
    code: error?.details?.errorCode || error?.code || "UnknownError",
    statusCode: error?.statusCode || null,
    message: error?.message || String(error)
  };
}

function describeBlobTarget() {
  const accountUrl = getBlobAccountUrl() || "<missing-account-url>";
  const containerName = getBlobContainerName() || "<missing-container>";
  const blobName = getBlobName();
  return `${accountUrl}/${containerName}/${blobName}`;
}

function markBlobReady(reason) {
  const patch = {
    activeMode: "blob",
    blobAccessState: "ready",
    lastBlobError: null
  };
  if (reason === "synced") {
    patch.pendingBlobSync = false;
  }
  updatePersistenceState(patch);
  emitPersistenceEvent("log", "persistence.blob_ready", {
    reason,
    target: describeBlobTarget(),
    activeMode: persistenceState.activeMode,
    pendingBlobSync: persistenceState.pendingBlobSync
  });
}

function markBlobDegraded(error, patch = {}) {
  updatePersistenceState({
    activeMode: "local",
    blobAccessState: "degraded",
    lastBlobError: snapshotBlobError(error),
    ...patch
  });
}

function scheduleBlobRecovery() {
  if (getPersistenceMode() !== "blob" || persistenceState.blobAccessState === "ready" || blobRecoveryTimer || blobRecoveryRunning) {
    return;
  }
  blobRecoveryTimer = setTimeout(() => {
    blobRecoveryTimer = null;
    void recoverBlobAccess();
  }, getBlobRecoveryIntervalMs());
}

async function recoverBlobAccess() {
  if (getPersistenceMode() !== "blob" || persistenceState.blobAccessState === "ready" || blobRecoveryRunning) {
    return;
  }

  blobRecoveryRunning = true;
  try {
    const filePath = getConfigPath();
    if (persistenceState.pendingBlobSync) {
      const localText = await tryReadLocalConfigText(filePath);
      if (localText != null) {
        await writeBlobConfigText(localText);
        markBlobReady("synced");
        return;
      }
    }

    await readBlobConfigText();
    markBlobReady("probe");
  } catch (error) {
    markBlobDegraded(error);
    emitPersistenceEvent("warn", "persistence.blob_probe_failed", {
      target: describeBlobTarget(),
      activeMode: persistenceState.activeMode,
      pendingBlobSync: persistenceState.pendingBlobSync,
      error: persistenceState.lastBlobError
    });
  } finally {
    blobRecoveryRunning = false;
    if (persistenceState.blobAccessState !== "ready") {
      scheduleBlobRecovery();
    }
  }
}

export function getPersistenceMode() {
  const mode = normalizeMode(process.env.PERSISTENCE_MODE || process.env.CONFIG_PERSISTENCE_MODE);
  persistenceState.configuredMode = mode;
  if (mode !== "blob") {
    updatePersistenceState({
      activeMode: DEFAULT_PERSISTENCE_MODE,
      blobAccessState: "disabled",
      pendingBlobSync: false,
      lastBlobError: null
    });
  }
  return mode;
}

export function getConfigPath() {
  const envPath = process.env.CONFIG_PATH || "./config/config.json";
  return path.resolve(process.cwd(), envPath);
}

function getBlobAccountUrl() {
  return String(process.env.BLOB_ACCOUNT_URL || process.env.AZURE_STORAGE_ACCOUNT_URL || "").trim();
}

function getBlobContainerName() {
  return String(process.env.CONFIG_BLOB_CONTAINER || process.env.BLOB_CONTAINER_NAME || "").trim();
}

function getBlobName() {
  return String(process.env.CONFIG_BLOB_NAME || DEFAULT_CONFIG_BLOB_NAME).trim();
}

function getBlobCredential() {
  if (!blobCredential) {
    blobCredential = new DefaultAzureCredential({
      managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined
    });
  }
  return blobCredential;
}

function getBlobService() {
  if (!blobServiceClient) {
    const accountUrl = getBlobAccountUrl();
    if (!accountUrl) {
      throw new Error("BLOB_ACCOUNT_URL or AZURE_STORAGE_ACCOUNT_URL is required when persistence mode is blob");
    }
    blobServiceClient = new BlobServiceClient(accountUrl, getBlobCredential());
  }
  return blobServiceClient;
}

async function ensureLocalDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readLocalConfigText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function writeLocalConfigText(filePath, text) {
  await ensureLocalDirectory(filePath);
  await fs.writeFile(filePath, text, "utf8");
}

async function readBlobConfigText() {
  const containerName = getBlobContainerName();
  if (!containerName) {
    throw new Error("CONFIG_BLOB_CONTAINER or BLOB_CONTAINER_NAME is required when persistence mode is blob");
  }
  const containerClient = getBlobService().getContainerClient(containerName);
  const blobClient = containerClient.getBlockBlobClient(getBlobName());
  try {
    const response = await blobClient.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error?.statusCode === 404 || error?.details?.errorCode === "BlobNotFound" || error?.code === "BlobNotFound") {
      return null;
    }
    throw error;
  }
}

async function writeBlobConfigText(text) {
  const containerName = getBlobContainerName();
  if (!containerName) {
    throw new Error("CONFIG_BLOB_CONTAINER or BLOB_CONTAINER_NAME is required when persistence mode is blob");
  }
  const containerClient = getBlobService().getContainerClient(containerName);
  await containerClient.createIfNotExists();
  const blobClient = containerClient.getBlockBlobClient(getBlobName());
  await blobClient.upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: {
      blobContentType: "application/json; charset=utf-8"
    }
  });
}

async function tryReadLocalConfigText(filePath) {
  try {
    return await readLocalConfigText(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readPersistedConfigText() {
  const mode = getPersistenceMode();
  const filePath = getConfigPath();
  if (mode !== "blob") {
    return readLocalConfigText(filePath);
  }

  if (persistenceState.pendingBlobSync) {
    const localText = await tryReadLocalConfigText(filePath);
    if (localText != null) {
      scheduleBlobRecovery();
      return localText;
    }
  }

  let blobText;
  try {
    blobText = await readBlobConfigText();
    markBlobReady("read");
  } catch (error) {
    if (isBlobAuthorizationError(error)) {
      const localText = await tryReadLocalConfigText(filePath);
      if (localText != null) {
        markBlobDegraded(error);
        emitPersistenceEvent("warn", "startup.persistence_blob_fallback", {
          reason: error?.details?.errorCode || error?.code || "AuthorizationFailed",
          target: describeBlobTarget(),
          configPath: filePath,
          message: "Blob config read is not authorized. Falling back to local cached config.",
          activeMode: persistenceState.activeMode,
          pendingBlobSync: persistenceState.pendingBlobSync
        });
        scheduleBlobRecovery();
        return localText;
      }
      throw new Error(`Blob config read is not authorized and no local fallback config exists at ${filePath}. Check Storage Blob Data Contributor or Reader access for ${describeBlobTarget()}.`);
    }
    throw error;
  }

  if (blobText != null) {
    await writeLocalConfigText(filePath, blobText);
    return blobText;
  }

  return readLocalConfigText(filePath);
}

export async function writePersistedConfigText(text) {
  const mode = getPersistenceMode();
  const filePath = getConfigPath();
  await writeLocalConfigText(filePath, text);
  if (mode === "blob") {
    try {
      await writeBlobConfigText(text);
      markBlobReady("write");
    } catch (error) {
      markBlobDegraded(error, { pendingBlobSync: true });
      emitPersistenceEvent("warn", "persistence.blob_write_deferred", {
        target: describeBlobTarget(),
        configPath: filePath,
        message: "Blob config write failed. Local config was updated and blob sync will retry in the background.",
        activeMode: persistenceState.activeMode,
        pendingBlobSync: persistenceState.pendingBlobSync,
        error: persistenceState.lastBlobError
      });
      scheduleBlobRecovery();
    }
  }
}

export function getPersistenceSummary() {
  return {
    mode: getPersistenceMode(),
    activeMode: persistenceState.activeMode,
    blobAccessState: persistenceState.blobAccessState,
    pendingBlobSync: persistenceState.pendingBlobSync,
    lastBlobError: persistenceState.lastBlobError,
    configPath: getConfigPath(),
    blobAccountUrl: getBlobAccountUrl(),
    blobContainerName: getBlobContainerName(),
    configBlobName: getBlobName()
  };
}
