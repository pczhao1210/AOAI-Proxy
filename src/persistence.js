import fs from "node:fs/promises";
import path from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

const DEFAULT_PERSISTENCE_MODE = "azureFile";
const DEFAULT_CONFIG_BLOB_NAME = "config/config.json";

let blobServiceClient = null;
let blobCredential = null;

function normalizeMode(mode) {
  return mode === "blob" ? "blob" : DEFAULT_PERSISTENCE_MODE;
}

export function getPersistenceMode() {
  return normalizeMode(process.env.PERSISTENCE_MODE || process.env.CONFIG_PERSISTENCE_MODE);
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

export async function readPersistedConfigText() {
  const mode = getPersistenceMode();
  const filePath = getConfigPath();
  if (mode !== "blob") {
    return readLocalConfigText(filePath);
  }

  const blobText = await readBlobConfigText();
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
    await writeBlobConfigText(text);
  }
}

export function getPersistenceSummary() {
  return {
    mode: getPersistenceMode(),
    configPath: getConfigPath(),
    blobAccountUrl: getBlobAccountUrl(),
    blobContainerName: getBlobContainerName(),
    configBlobName: getBlobName()
  };
}
