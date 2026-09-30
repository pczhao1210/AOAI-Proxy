import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getModelCardTemplateDefaults } from "../src/model-card.js";
import { compileDefinitionPricing } from "../src/pricing-policy.js";
import { compilePricingPolicy } from "../src/token-pricing.js";

const ROOT_FIELDS = [
  "schemaVersion", "id", "aliases", "displayName", "provider", "family", "modelVersion", "status",
  "contextWindow", "maxInputTokens", "maxOutputTokens",
  "hostingModes", "defaultHostingMode", "interfacesByHostingMode", "interfaces", "defaultInterface",
  "inputModalities", "outputModalities", "capabilities", "proxyAdapters", "protocolProfiles",
  "pricing", "pricingCatalogEntry", "proxyTemplate", "sources", "notes"
];
const RATE_NAMES = ["input", "cachedInput", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "output"];
const PRICE_FIELDS = [
  "currency", "billingUnit", "sourceType", "status", "id", "deploymentType", "contextClass",
  "promptTokensAtLeast", "promptTokensBelow", ...RATE_NAMES.map(name => `${name}Per1mTokens`),
  "tiering", "tiers", "channels"
];

function orderFields(value, fields) {
  return Object.fromEntries([
    ...fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]),
    ...Object.keys(value).filter(key => !fields.includes(key)).map(key => [key, value[key]])
  ]);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateModelCard(card) {
  const errors = [];
  const warnings = [];
  const text = value => typeof value === "string" && value.trim().length > 0;
  const strings = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const source = field => {
    try {
      const url = new URL(card.sources?.[field]);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    } catch {
      errors.push(`sources.${field}: expected an evidence URL`);
    }
  };
  if (!isObject(card)) return { errors: ["card: expected an object"], warnings };
  for (const field of ["id", "displayName", "provider", "family"]) {
    if (!text(card[field])) errors.push(`${field}: required nonempty string`);
  }
  for (const field of ["interfaces", "inputModalities", "outputModalities", "capabilities"]) {
    if (!strings(card[field])) errors.push(`${field}: required nonempty string array`);
  }
  source("capabilities");
  source("pricing");
  const limits = ["contextWindow", "maxInputTokens", "maxOutputTokens"];
  for (const field of limits) {
    if (card[field] == null) continue;
    if (!Number.isSafeInteger(card[field]) || card[field] <= 0) {
      errors.push(`${field}: expected a positive safe integer`);
    } else if (field !== "contextWindow" && card.contextWindow != null && card[field] > card.contextWindow) {
      errors.push(`${field}: must not exceed contextWindow`);
    }
  }
  if (limits.some(field => card[field] != null)) source("limits");
  const textModel = Array.isArray(card.interfaces)
    && card.interfaces.some(protocol => ["chat/completions", "responses", "messages"].includes(protocol));
  if (textModel) {
    for (const field of limits) {
      if (card[field] == null) warnings.push(`${field}: not recorded; add only with deployment-specific evidence`);
    }
  }
  const profiles = isObject(card.protocolProfiles) ? card.protocolProfiles : {};
  if (card.protocolProfiles != null && !isObject(card.protocolProfiles)) {
    errors.push("protocolProfiles: expected an object");
  }
  if (Array.isArray(card.capabilities) && card.capabilities.includes("reasoning") && !Object.values(profiles).some(profile =>
    profile?.reasoning?.parameter || profile?.reasoning?.configurable === false || profile?.thinking?.parameter)) {
    errors.push("protocolProfiles: reasoning capability requires a reasoning or thinking profile");
  }
  for (const [protocol, profile] of Object.entries(profiles)) {
    if (!isObject(profile)) {
      errors.push(`protocolProfiles.${protocol}: expected an object`);
      continue;
    }
    for (const [kind, choices] of [["reasoning", "levels"], ["thinking", "types"]]) {
      const control = profile[kind];
      const prefix = `protocolProfiles.${protocol}.${kind}`;
      if (control == null) continue;
      if (!isObject(control)) {
        errors.push(`${prefix}: expected an object`);
        continue;
      }
      if (control.configurable != null && typeof control.configurable !== "boolean") {
        errors.push(`${prefix}.configurable: expected a boolean`);
      }
      if (control.configurable === false) continue;
      if (!text(control.parameter)) errors.push(`${prefix}.parameter: required for configurable controls`);
      if (control[choices] == null) warnings.push(`${prefix}.${choices}: not recorded; verify provider support`);
      else if (!strings(control[choices])) errors.push(`${prefix}.${choices}: expected a nonempty string array`);
      if (control.default == null) warnings.push(`${prefix}.default: not recorded; do not assume a family default`);
      else if (!text(control.default) || (strings(control[choices]) && !control[choices].includes(control.default))) {
        errors.push(`${prefix}.default: must be a nonempty string included in ${choices} when declared`);
      }
    }
  }
  if (!isObject(card.pricing)) errors.push("pricing: required object (unpublished rates must remain absent)");
  for (const field of ["pricing", "pricingCatalogEntry"]) {
    const pricing = card[field];
    if (pricing == null) continue;
    if (!isObject(pricing)) {
      if (field !== "pricing") errors.push(`${field}: expected an object or null`);
      continue;
    }
    if (field === "pricing") {
      for (const key of ["currency", "billingUnit"]) {
        if (key === "billingUnit" && pricing.status === "unavailable" && pricing[key] == null) {
          warnings.push(`${field}.${key}: unpublished; verify together with rates`);
          continue;
        }
        if (!text(pricing[key])) errors.push(`${field}.${key}: required nonempty string`);
      }
    }
    try {
      canonicalizeRates(pricing);
      // Reference-only media tables are not executable token policies.
      if (pricing.tiering || field === "pricingCatalogEntry" || card.pricingCatalogEntry !== null) {
        compilePricingPolicy(pricing, field);
      }
    } catch (error) {
      errors.push(`${field}: ${error.message}`);
    }
    if (pricing.tiering && Array.isArray(pricing.tiers)) {
      for (const [index, tier] of pricing.tiers.entries()) {
        if (!text(tier?.id)) errors.push(`${field}.tiers[${index}].id: explicit descriptive ID required`);
      }
    }
    if (textModel && (field === "pricingCatalogEntry" || !Object.hasOwn(card, "pricingCatalogEntry"))) {
      const rows = Array.isArray(pricing.tiers) ? pricing.tiers : [pricing];
      for (const [index, row] of rows.entries()) {
        for (const rate of ["inputPer1mTokens", "outputPer1mTokens"]) {
          if (row?.[rate] == null) warnings.push(`${field}${pricing.tiers ? `.tiers[${index}]` : ""}.${rate}: not recorded; never substitute zero`);
        }
      }
    }
  }
  return { errors, warnings };
}

function equivalent(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    return left === right || (left !== 0 && right !== 0
      && Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(Math.abs(left), Math.abs(right)));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equivalent(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    return Object.keys(left).length === Object.keys(right).length
      && Object.keys(left).every(key => Object.hasOwn(right, key) && equivalent(left[key], right[key]));
  }
  return isDeepStrictEqual(left, right);
}

function canonicalizeRates(value) {
  if (Array.isArray(value)) return value.map(canonicalizeRates);
  if (!isObject(value)) return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonicalizeRates(child)]));
  for (const name of RATE_NAMES) {
    const perThousand = `${name}Per1kTokens`;
    const perMillion = `${name}Per1mTokens`;
    if (Object.hasOwn(result, perMillion)
      && (typeof result[perMillion] !== "number" || !Number.isFinite(result[perMillion]) || result[perMillion] < 0)) {
      throw new Error(`Invalid ${perMillion} rate`);
    }
    if (!Object.hasOwn(result, perThousand)) continue;
    const rate = result[perThousand];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(rate * 1000)) {
      throw new Error(`Invalid ${perThousand} rate`);
    }
    if (Object.hasOwn(result, perMillion) && !equivalent(result[perMillion], rate * 1000)) {
      throw new Error(`Conflicting ${perThousand} and ${perMillion} rates`);
    }
    result[perMillion] ??= rate * 1000;
    delete result[perThousand];
  }
  if (result.billingUnit === "1K tokens") result.billingUnit = "1M tokens";
  return orderFields(result, PRICE_FIELDS);
}

function effectivePolicy(pricing) {
  const policy = compilePricingPolicy(pricing);
  return policy?.tiering ? { ...policy, rates: {} } : policy;
}

function containsEntry(root, entry) {
  if (isObject(root) && isObject(entry)) {
    return Object.keys(entry).every(key => Object.hasOwn(root, key) && containsEntry(root[key], entry[key]));
  }
  if (Array.isArray(root) && Array.isArray(entry)) {
    return root.length === entry.length && entry.every((item, index) => containsEntry(root[index], item));
  }
  return equivalent(root, entry);
}

export function canonicalizeModelCard(raw) {
  if (!isObject(raw) || !raw.id) throw new Error("Model card must be an object with an id");
  compileDefinitionPricing(raw);
  const card = structuredClone(raw);
  if (Object.hasOwn(card, "pricing")) card.pricing = canonicalizeRates(card.pricing);
  if (isObject(card.pricingCatalogEntry)) card.pricingCatalogEntry = canonicalizeRates(card.pricingCatalogEntry);
  const pricing = card.pricing;
  if (pricing?.tiering?.method === "whole-request" && Array.isArray(pricing.tiers) && !pricing.channels) {
    for (const name of RATE_NAMES) {
      const key = `${name}Per1mTokens`;
      if (!Object.hasOwn(pricing, key)) continue;
      if (!equivalent(pricing[key], pricing.tiers[0]?.[key])) {
        throw new Error(`Conflicting whole-request root ${key}; store rates only in tiers`);
      }
      delete pricing[key];
    }
    const entry = card.pricingCatalogEntry;
    if (entry?.tiers?.length === pricing.tiers.length) {
      const candidate = structuredClone(pricing);
      for (const [index, row] of candidate.tiers.entries()) {
        if (!Object.hasOwn(row, "id") && Object.hasOwn(entry.tiers[index], "id")) row.id = entry.tiers[index].id;
      }
      if (equivalent(effectivePolicy(candidate), effectivePolicy(entry))) card.pricing = candidate;
    }
  }
  if (isObject(card.pricingCatalogEntry)) {
    const rootPolicy = effectivePolicy(card.pricing);
    if (rootPolicy && equivalent(rootPolicy, effectivePolicy(card.pricingCatalogEntry))
      && containsEntry(card.pricing, card.pricingCatalogEntry)) {
      delete card.pricingCatalogEntry;
    }
  }
  if (isObject(card.proxyTemplate)) {
    for (const [key, value] of Object.entries(getModelCardTemplateDefaults(card))) {
      if (isDeepStrictEqual(card.proxyTemplate[key], value)) delete card.proxyTemplate[key];
    }
    card.proxyTemplate = orderFields(card.proxyTemplate, ["id", "displayName", "targetModel", "hostingMode", "capabilities", "pricingRef", "routes"]);
  }
  if (isObject(card.pricing)) card.pricing = canonicalizeRates(card.pricing);
  return orderFields(card, ROOT_FIELDS);
}

function formatJson(value, depth = 0, field = "") {
  const indent = "  ".repeat(depth);
  const childIndent = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (field !== "notes" && value.every(item => item === null || typeof item !== "object")) {
      const inline = `[${value.map(item => JSON.stringify(item)).join(", ")}]`;
      if (childIndent.length + field.length + inline.length + 4 <= 120) return inline;
    }
    return `[\n${value.map(item => `${childIndent}${formatJson(item, depth + 1)}`).join(",\n")}\n${indent}]`;
  }
  if (isObject(value)) {
    if (!Object.keys(value).length) return "{}";
    return `{\n${Object.entries(value).map(([key, child]) =>
      `${childIndent}${JSON.stringify(key)}: ${formatJson(child, depth + 1, key)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

export function formatModelCard(card) {
  return `${formatJson(canonicalizeModelCard(card))}\n`;
}

async function main() {
  const mode = process.argv[2];
  if (!["--check", "--write", "--validate"].includes(mode) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/model-cards.js --check|--write|--validate");
  }
  const directory = new URL("../pricing/", import.meta.url);
  const names = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort();
  const candidates = await Promise.all(names.map(async name => {
    const url = new URL(name, directory);
    const text = await fs.readFile(url, "utf8");
    try {
      const card = JSON.parse(text);
      const validation = validateModelCard(card);
      return { name, url, text, id: card?.id, ...validation,
        formatted: validation.errors.length ? text : formatModelCard(card) };
    } catch (error) {
      return { name, url, text, formatted: text, errors: [error.message], warnings: [] };
    }
  }));
  const ids = new Set();
  for (const entry of candidates) {
    if (typeof entry.id === "string") {
      const id = entry.id.trim().toLowerCase();
      if (ids.has(id)) entry.errors.push(`id: duplicate ${entry.id}`);
      ids.add(id);
    }
    for (const error of entry.errors) console.error(`pricing/${entry.name}: ${error}`);
    if (mode === "--validate") {
      for (const warning of entry.warnings) console.warn(`REVIEW pricing/${entry.name}: ${warning}`);
    }
  }
  const errors = candidates.reduce((sum, entry) => sum + entry.errors.length, 0);
  if (mode === "--validate" || errors) {
    const warnings = candidates.reduce((sum, entry) => sum + entry.warnings.length, 0);
    console.log(`${names.length} active cards validated; ${errors} errors; ${warnings} fields to review. Archives excluded.`);
    if (errors) process.exitCode = 1;
    return;
  }
  const changed = candidates.filter(entry => entry.text !== entry.formatted);
  for (const entry of changed) {
    if (mode === "--write") await fs.writeFile(entry.url, entry.formatted);
    else console.error(`Noncanonical model card: pricing/${entry.name}`);
  }
  console.log(`${names.length} active cards checked; ${changed.length} ${mode === "--write" ? "formatted" : "need formatting"}. Archives excluded.`);
  if (changed.length && mode === "--check") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
