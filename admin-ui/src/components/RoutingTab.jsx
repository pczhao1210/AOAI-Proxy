import { useCallback, useState } from "react";
import { EntityCard, Field, ListInput, Section } from "./ui.jsx";
import { BindingSelect, channelCandidates, ExposurePicker, MappingEditor } from "./ChannelModels.jsx";
import CopilotChannel from "./CopilotChannel.jsx";
import { copilotIdentity, isCopilotChannel } from "../copilot.js";
import {
  applyPricingTemplateToModel,
  findPricingTemplateByHint,
  findPricingTemplateForModel,
  formatList,
  getSuggestedModelRouteValues,
  supportsPricingTemplate,
  syncUpstreamCapabilities,
  upsertPricingCatalogEntry
} from "../utils.js";

function getRouteOptionLabel(t, value) {
  return t(`routing.route.${value}`, value);
}

function setModelWildcardRoute(next, modelIndex, value) {
  const currentRoutes = next.models?.[modelIndex]?.routes && typeof next.models[modelIndex].routes === "object"
    ? next.models[modelIndex].routes
    : {};
  const routes = { ...currentRoutes };
  if (!value) {
    delete routes["*"];
  } else {
    routes["*"] = value;
  }
  next.models[modelIndex].routes = routes;
}

function getClientCompatibilityMeta(t, model) {
  const clients = [
    ["claudeCode", "Claude Code"],
    ["codex", "Codex"]
  ];
  return clients
    .filter(([clientName]) => model?.clientCompatibility?.[clientName] === true)
    .map(([clientName, label]) => `${label}: ${t("routing.compatibility.catalogMember", "Catalog member")}${
      model?.clientNativeRoute?.[clientName] === true ? ` (${t("routing.compatibility.nativeRoute", "native route override")})`
        : model?.clientConversion?.[clientName] === true ? ` (${t("routing.compatibility.conversion", "protocol conversion")})` : ""
    }`)
    .join(" · ");
}

function syncModelUpstreams(next, modelIndex, previousUpstream) {
  const currentUpstream = next.models?.[modelIndex]?.upstream;
  if (previousUpstream) {
    syncUpstreamCapabilities(next, previousUpstream);
  }
  if (currentUpstream && currentUpstream !== previousUpstream) {
    syncUpstreamCapabilities(next, currentUpstream);
  }
}

export default function RoutingTab({
  config, loadedConfig, copilotOperations, pricingLibrary, capabilityView, capabilitiesLoading, capabilitiesError, capabilityPreview, capabilityFallbackModels = [],
  updateConfig, addUpstream, addModel, addBlankModel, mappingDrafts = {}, setMappingDrafts, onEditKey, t
}) {
  const [search, setSearch] = useState("");
  const [copilotEvidence, setCopilotEvidence] = useState(new Map());
  const onEvidence = useCallback((identity, allowed) => setCopilotEvidence(prev => {
    if (!allowed?.size && !prev.has(identity)) return prev;
    const next = new Map(prev);
    if (allowed?.size) next.set(identity, allowed);
    else next.delete(identity);
    return next;
  }), []);
  const searchTerm = search.trim().toLowerCase();
  const upstreams = config.upstreams || [];
  const upstreamOptions = config.upstreams || [];
  const catalogDefinitions = pricingLibrary || [];
  const templateOptions = catalogDefinitions.filter((definition) => supportsPricingTemplate(definition));
  const mappingDefinitions = [...catalogDefinitions];
  const mappingIds = new Set(mappingDefinitions.map(card => card.id));
  for (const model of capabilityView?.models || []) {
    if (model.canonicalModelId && !mappingIds.has(model.canonicalModelId)) {
      mappingDefinitions.push({ id: model.canonicalModelId });
      mappingIds.add(model.canonicalModelId);
    }
  }
  const groups = channelCandidates(upstreams, mappingDefinitions, copilotEvidence);
  const hasLegacyChannels = !upstreams.length || upstreams.some(up => !up.channelId);

  function applyTemplateForModel(next, modelIndex, definition) {
    if (!definition || !next?.models?.[modelIndex]) return;

    next.models[modelIndex] = applyPricingTemplateToModel(next, next.models[modelIndex], definition);
    upsertPricingCatalogEntry(next, definition);

    const upstreamName = next.models[modelIndex].upstream;
    if (upstreamName) {
      syncUpstreamCapabilities(next, upstreamName);
    }
  }

  function autoMatchTemplate(next, modelIndex) {
    const definition = findPricingTemplateForModel(templateOptions, next?.models?.[modelIndex]);
    if (!definition) return;
    applyTemplateForModel(next, modelIndex, definition);
  }

  const filteredUpstreams = upstreams
    .map((item, index) => ({ item, index, copilot: isCopilotChannel(item),
      hidden: !!searchTerm && ![item.name, item.baseUrl].some(value => value?.toLowerCase().includes(searchTerm)) }))
    .filter(({ hidden, copilot }) => !hidden || copilot);

  const models = config.models || [];
  const filteredModels = models
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (
      !searchTerm
      || (item.id || "").toLowerCase().includes(searchTerm)
      || (item.displayName || "").toLowerCase().includes(searchTerm)
      || (item.upstream || "").toLowerCase().includes(searchTerm)
    ));

  return (
    <Section
      title={t("routing.title", "Upstream / Model")}
      desc={t("routing.desc", "Maintain upstreams and model mappings.")}
      actions={
        <div className="toolbar-cluster">
          <input
            className="search-field"
            type="search"
            placeholder={t("routing.search", "Search upstreams or models...")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="button" className="ghost" onClick={addUpstream}>{t("routing.addUpstream", "Add Upstream")}</button>
          <button type="button" className="ghost" onClick={() => addUpstream("github-copilot")}>{t("copilot.add")}</button>
          {hasLegacyChannels && <button type="button" className="ghost" onClick={addBlankModel}>{t("routing.addBlankModel", "Add Blank Model")}</button>}
          {hasLegacyChannels && <button type="button" onClick={addModel}>{t("routing.addModel", "Add Model")}</button>}
        </div>
      }
    >
      <div className="stack-lg">
        <p className="muted" role="status">
          {capabilitiesLoading
            ? t("routing.capabilities.loading", "Loading effective capabilities...")
            : capabilityView
              ? capabilityPreview
                ? t("routing.capabilities.draft", "Draft preview (not saved)")
                : t("routing.capabilities.active", "Active configuration")
              : t("routing.capabilities.unavailable", "Capability information unavailable.")}
        </p>
        {capabilitiesError ? <p role="alert">{capabilitiesError}</p> : null}
        <div id="routing-upstreams">
          <h3 className="subhead">{t("entity.upstreams", "Upstreams")}</h3>
          <div className="entity-grid">
            {filteredUpstreams.map(({ item, index, copilot, hidden }) => {
              const capabilities = capabilityView?.upstreams?.find(upstream => upstream.name === item.name)?.capabilities;
              const capabilityCount = capabilities ? capabilities.length : "-";
              const statusLabel = t(`option.${item.status || "active"}`, item.status || "active");
              const authMode = item.auth?.mode || "inherit";
              return (
                <EntityCard
                  id={`upstream-card-${index}`}
                  hidden={hidden}
                  key={item.channelId || `upstream-${index}`}
                  title={item.name || `upstream-${index + 1}`}
                  subtitle={item.baseUrl || t("status.upstreamSubtitleFallback", "Base URL not configured")}
                  meta={`${t("field.provider", "Provider")}: ${item.provider || "azure-openai"} · ${t("field.status", "Status")}: ${statusLabel} · ${t("field.capabilities", "Capabilities")}: ${capabilityCount}`}
                  removeLabel={t("entity.delete", "Delete")}
                  expandLabel={t("entity.expand", "Edit configuration")}
                  collapseLabel={t("entity.collapse", "Collapse")}
                  collapsible
                  defaultOpen={false}
                  group="routing-upstreams"
                  onRemove={() => updateConfig((next) => {
                    next.upstreams = (next.upstreams || []).filter((_, upstreamIndex) => upstreamIndex !== index);
                  })}
                >
                  <div className="form-grid compact">
                    <Field label={t("field.name", "Name")}><input value={item.name || ""} onChange={(event) => updateConfig((next) => {
                      const oldName = next.upstreams[index].name;
                      next.upstreams[index].name = event.target.value;
                      for (const model of next.models || []) if (model.upstream === oldName) model.upstream = event.target.value;
                    })} /></Field>
                    <Field label={t("field.provider", "Provider")}><input readOnly={copilot} value={item.provider || "azure-openai"} onChange={(event) => {
                      const provider = event.target.value;
                      if (provider.trim().toLowerCase() !== "github-copilot") updateConfig(next => { next.upstreams[index].provider = provider; });
                    }} /></Field>
                    <Field label={t("field.status", "Status")}><select value={item.status || "active"} onChange={(event) => updateConfig((next) => { next.upstreams[index].status = event.target.value; })}><option value="active">{t("option.active", "active")}</option><option value="disabled">{t("option.disabled", "disabled")}</option></select></Field>
                    <Field label={t("field.priority", "Priority")}><input type="number" value={item.priority || 0} onChange={(event) => updateConfig((next) => { next.upstreams[index].priority = Number(event.target.value || 0); })} /></Field>
                  </div>
                  <Field label={t("field.baseUrl", "Base URL")}><input readOnly={copilot} value={item.baseUrl || ""} onChange={(event) => updateConfig((next) => { next.upstreams[index].baseUrl = event.target.value; })} /></Field>
                  {!copilot && <div className="form-grid compact">
                    <Field label={t("field.upstreamAuthMode", "Authentication")}>
                      <select value={authMode} onChange={(event) => updateConfig((next) => {
                        next.upstreams[index].auth = next.upstreams[index].auth || {};
                        next.upstreams[index].auth.mode = event.target.value === "inherit" ? "" : event.target.value;
                        if (event.target.value !== "apiKey") {
                          next.upstreams[index].auth.apiKey = "";
                        }
                      })}>
                        <option value="inherit">{t("option.inheritAuth", "Inherit Global Authentication")}</option>
                        <option value="managedIdentity">{t("option.managedIdentity", "Managed Identity")}</option>
                        <option value="apiKey">{t("option.apiKey", "API Key")}</option>
                      </select>
                    </Field>
                    {authMode === "apiKey" ? (
                      <Field label={t("field.upstreamApiKey", "Upstream API Key")} hint={t("field.upstreamApiKeyHint", "Stored securely and sent only to this upstream.")}>
                        <input type="password" autoComplete="new-password" value={item.auth?.apiKey || ""} onChange={(event) => updateConfig((next) => {
                          next.upstreams[index].auth = next.upstreams[index].auth || {};
                          next.upstreams[index].auth.mode = "apiKey";
                          next.upstreams[index].auth.apiKey = event.target.value;
                        })} />
                      </Field>
                    ) : null}
                  </div>}
                  <Field
                    label={t("routing.capabilities.combined", "Combined model capabilities")}
                    hint={t("routing.capabilities.unionHint", "Union of bound models' effective capabilities; not a guarantee for every model or an upstream restriction.")}
                  ><input value={formatList(capabilities)} readOnly disabled={!capabilities} /></Field>
                  {copilot ? <CopilotChannel key={copilotIdentity(item)} up={item} definitions={mappingDefinitions} tickets={copilotOperations}
                    saved={loadedConfig?.upstreams?.find(up => item.channelId === up.channelId)}
                    referenced={[...new Set([...models, ...(loadedConfig?.models || [])]
                      .filter(m => m.selectedBinding?.channelId === item.channelId).map(m => m.id))]}
                    updateConfig={updateConfig} onEvidence={onEvidence} t={t} /> :
                    <MappingEditor up={item} saved={loadedConfig?.upstreams?.find(up => item.channelId === up.channelId)}
                      index={index} config={config} capabilityView={capabilityView}
                      definitions={mappingDefinitions} updateConfig={updateConfig} drafts={mappingDrafts} setDrafts={setMappingDrafts} t={t} />}
                </EntityCard>
              );
            })}
          </div>
        </div>

        <div id="routing-models">
          <h3 className="subhead">{t("channel.exposure", "Exposed models")}</h3>
          <ExposurePicker groups={groups} models={models} search={searchTerm} updateConfig={updateConfig} t={t} />
          {(config.apiKeys || []).map((key, index) => {
            const missing = (key.allowedModels || []).filter(id => !models.some(model => model.id === id));
            return missing.length ? <p key={index} role="alert">{t("channel.referenced")} {missing.join(", ")} ·
              <button type="button" className="ghost" onClick={() => onEditKey(index)}>{t("channel.editKey")} {key.id}</button></p> : null;
          })}
          <div className="entity-grid">
            {filteredModels.map(({ item, index }) => {
              const capabilityModel = capabilityView?.models?.find(model => model.modelId === item.id);
              const catalogCapabilities = capabilityModel?.source === "catalog";
              const statusLabel = t(`option.${item.status || "active"}`, item.status || "active");
              const clientCompatibilityMeta = getClientCompatibilityMeta(t, item);
              const matchedDefinition = findPricingTemplateForModel(catalogDefinitions, item);
              const matchedTemplate = supportsPricingTemplate(matchedDefinition) ? matchedDefinition : null;
              const hostingModes = Array.isArray(matchedDefinition?.hostingModes) ? matchedDefinition.hostingModes : [];
              const wildcardRoute = typeof item?.routes?.["*"] === "string" ? item.routes["*"].trim() : "";
              const routeOptions = getSuggestedModelRouteValues(matchedDefinition, item.hostingMode);
              const hasUnavailableRoute = wildcardRoute && !routeOptions.includes(wildcardRoute);
              const allRouteOptions = hasUnavailableRoute ? [wildcardRoute, ...routeOptions] : routeOptions;
              const choices = groups.get(item.canonicalModelId) || [];
              const binding = item.selectedBinding;
              const references = (config.apiKeys || []).filter(key => key.allowedModels?.includes(item.id));
              return (
                <EntityCard
                  id={`model-card-${index}`}
                  key={`model-${index}`}
                  title={item.displayName || item.id || `model-${index + 1}`}
                  subtitle={(binding ? upstreams.find(up => up.channelId === binding.channelId)?.name : item.upstream) || t("status.modelSubtitleFallback", "Upstream not bound")}
                  meta={`${binding ? t("channel.source") : t("routing.field.azureDeployment", "Azure Deployment Name")}: ${binding?.sourceModelId || item.targetModel || "-"} · ${t("field.status", "Status")}: ${statusLabel}${clientCompatibilityMeta ? ` · ${clientCompatibilityMeta}` : ""}`}
                  removeLabel={t("entity.delete", "Delete")}
                  expandLabel={t("entity.expand", "Edit configuration")}
                  collapseLabel={t("entity.collapse", "Collapse")}
                  collapsible
                  defaultOpen={false}
                  group="routing-models"
                  onRemove={() => updateConfig((next) => {
                    const upstreamName = next.models?.[index]?.upstream;
                    next.models = (next.models || []).filter((_, modelIndex) => modelIndex !== index);
                    syncUpstreamCapabilities(next, upstreamName);
                  })}
                >
                  <div className="form-grid compact">
                    <Field
                      label={t("routing.field.proxyModelId", "Proxy Model ID")}
                      hint={t("routing.hint.proxyModelId", "Clients send this value in the model field when calling the proxy.")}
                    ><input value={item.id || ""} onChange={(event) => updateConfig((next) => { next.models[index].id = event.target.value; if (!binding) autoMatchTemplate(next, index); })} /></Field>
                    <Field label={t("field.displayName", "Display Name")}><input value={item.displayName || ""} onChange={(event) => updateConfig((next) => { next.models[index].displayName = event.target.value; })} /></Field>
                    {binding ? <BindingSelect choices={choices} value={binding} onChange={ref => updateConfig(next => {
                      const model = next.models[index];
                      model.selectedBinding = ref;
                      delete model.confirmedRouteBinding;
                      delete model.clientNativeRoute;
                      delete model.clientConversion;
                    })} t={t} /> : <><Field label={t("routing.template.field", "Template")}>
                      <select
                        value={matchedTemplate?.id || ""}
                        onChange={(event) => updateConfig((next) => {
                          const definition = findPricingTemplateByHint(templateOptions, event.target.value);
                          if (!definition) return;
                          applyTemplateForModel(next, index, definition);
                        })}
                      >
                        <option value="">{t("routing.template.none", "No template matched")}</option>
                        {templateOptions.map((definition) => (
                          <option key={definition.id} value={definition.id}>{definition.displayName || definition.id}</option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label={t("routing.field.azureDeployment", "Azure Deployment Name")}
                      hint={t("routing.hint.azureDeployment", "This is the upstream deployment or target model actually sent to Azure.")}
                    ><input value={item.targetModel || ""} onChange={(event) => updateConfig((next) => { next.models[index].targetModel = event.target.value; autoMatchTemplate(next, index); })} /></Field>
                    <Field label={t("field.upstream", "Upstream")}>
                      <select value={item.upstream || ""} onChange={(event) => updateConfig((next) => {
                        const previousUpstream = next.models?.[index]?.upstream;
                        next.models[index].upstream = event.target.value;
                        syncModelUpstreams(next, index, previousUpstream);
                      })}>
                        <option value="">-</option>
                        {upstreamOptions.filter(up => !up.channelId).map((upstream) => <option key={upstream.name} value={upstream.name}>{upstream.name}</option>)}
                      </select>
                    </Field>
                    {hostingModes.length > 1 ? (
                      <Field
                        label={t("routing.field.hostingMode", "Claude Hosting Mode")}
                        hint={t("routing.hint.hostingMode", "Select the deployment infrastructure for region, data handling, and capability metadata.")}
                      >
                        <select value={item.hostingMode || matchedTemplate?.defaultHostingMode || ""} onChange={(event) => updateConfig((next) => { next.models[index].hostingMode = event.target.value; })}>
                          {hostingModes.map((mode) => (
                            <option key={mode} value={mode}>{mode === "azure" ? t("routing.hosting.azure", "Hosted on Azure") : t("routing.hosting.anthropic", "Hosted on Anthropic infrastructure")}</option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                    <Field label={t("field.defaultRoute", "Default Route")}>
                      <select value={wildcardRoute} onChange={(event) => updateConfig((next) => { setModelWildcardRoute(next, index, event.target.value); })}>
                        <option value="">{t("routing.route.auto", "Use template default")}</option>
                        {allRouteOptions.map((routeValue) => (
                          <option key={routeValue} value={routeValue} disabled={hasUnavailableRoute && routeValue === wildcardRoute}>
                            {hasUnavailableRoute && routeValue === wildcardRoute
                              ? `${t("routing.route.unavailable", "Not allowed by Model Catalog")}: ${routeValue}`
                              : getRouteOptionLabel(t, routeValue)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label={t("routing.field.pricingTemplateId", "Pricing Template ID")}
                      hint={t("routing.hint.pricingTemplateId", "Used to match pricing library metadata and governance pricing, not the Azure deployment name.")}
                    ><input value={item.pricingRef || ""} onChange={(event) => updateConfig((next) => { next.models[index].pricingRef = event.target.value; autoMatchTemplate(next, index); })} /></Field></>}
                    <Field label={t("field.status", "Status")}><select value={item.status || "active"} onChange={(event) => updateConfig((next) => { next.models[index].status = event.target.value; })}><option value="active">{t("option.active", "active")}</option><option value="disabled">{t("option.disabled", "disabled")}</option></select></Field>
                  </div>
                  {references.length > 0 && <p>{t("channel.referenced")} {references.map(key => key.id).join(", ")}</p>}
                  {binding && <p className="muted">{t("channel.switchHint")}</p>}
                  <Field
                    label={t("routing.capabilities.effective", "Effective capabilities")}
                    hint={capabilityModel
                      ? catalogCapabilities
                        ? t("routing.capabilities.catalog", "Source: Model Catalog (read-only).")
                        : capabilityModel.source === "model-config"
                          ? t("routing.capabilities.legacy", "Source: Model configuration (legacy fallback).")
                          : t("routing.capabilities.none", "Undeclared; legacy configuration fallback can be supplied here.")
                      : t("routing.capabilities.unavailable", "Capability information unavailable.")}
                  ><input
                    value={formatList(capabilityModel?.capabilities)}
                    readOnly
                    disabled={!capabilityModel}
                  /></Field>
                  {capabilityModel?.chatTokenParameter ? (
                    <p className="muted">
                      {t("routing.capabilities.tokenParameter", "Chat output token parameter")}:{" "}
                      {capabilityModel.chatTokenParameter.parameter
                        || t("routing.capabilities.legacyTokens", "Legacy compatibility (profile not yet declared)")}
                    </p>
                  ) : null}
                  {(capabilityModel && !catalogCapabilities) || capabilityFallbackModels.includes(item.id) ? (
                    <Field
                      label={t("routing.capabilities.fallback", "Legacy configuration capabilities")}
                      hint={t("routing.capabilities.legacy", "Source: Model configuration (legacy fallback).")}
                    ><ListInput value={item.capabilities} onChange={(value) => updateConfig((next) => {
                      next.models[index].capabilities = value;
                      syncUpstreamCapabilities(next, next.models[index].upstream);
                    })} /></Field>
                  ) : null}
                  {capabilityModel?.configurationMismatch ? (
                    <Field
                      label={t("routing.capabilities.stored", "Stored configuration labels")}
                      hint={t("routing.capabilities.mismatch", "These stored labels differ from the effective Catalog facts. They are retained, not used as a Catalog override.")}
                    ><input value={formatList(capabilityModel.configuredCapabilities)} readOnly /></Field>
                  ) : null}
                  <Field label={t("field.accessTags", "Access Tags")}><ListInput value={item.accessTags} onChange={(value) => updateConfig((next) => { next.models[index].accessTags = value; })} /></Field>
                </EntityCard>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}