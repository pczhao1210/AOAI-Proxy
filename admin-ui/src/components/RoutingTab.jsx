import { useState } from "react";
import { EntityCard, Field, Section } from "./ui.jsx";
import {
  applyPricingTemplateToModel,
  findPricingTemplateByHint,
  findPricingTemplateForModel,
  formatList,
  getSuggestedModelRouteValues,
  isKnownModelRouteValue,
  parseList,
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

function syncModelUpstreams(next, modelIndex, previousUpstream) {
  const currentUpstream = next.models?.[modelIndex]?.upstream;
  if (previousUpstream) {
    syncUpstreamCapabilities(next, previousUpstream);
  }
  if (currentUpstream && currentUpstream !== previousUpstream) {
    syncUpstreamCapabilities(next, currentUpstream);
  }
}

export default function RoutingTab({ config, pricingLibrary, updateConfig, addUpstream, addModel, addBlankModel, t }) {
  const [search, setSearch] = useState("");
  const searchTerm = search.trim().toLowerCase();
  const upstreams = config.upstreams || [];
  const upstreamOptions = config.upstreams || [];
  const templateOptions = (pricingLibrary || []).filter((definition) => supportsPricingTemplate(definition));

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
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (
      !searchTerm
      || (item.name || "").toLowerCase().includes(searchTerm)
      || (item.baseUrl || "").toLowerCase().includes(searchTerm)
    ));

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
          <button type="button" className="ghost" onClick={addBlankModel}>{t("routing.addBlankModel", "Add Blank Model")}</button>
          <button type="button" onClick={addModel}>{t("routing.addModel", "Add Model")}</button>
        </div>
      }
    >
      <div className="stack-lg">
        <div id="routing-upstreams">
          <h3 className="subhead">{t("entity.upstreams", "Upstreams")}</h3>
          <div className="entity-grid">
            {filteredUpstreams.map(({ item, index }) => {
              const capabilityCount = Array.isArray(item.capabilities) ? item.capabilities.length : 0;
              const statusLabel = t(`option.${item.status || "active"}`, item.status || "active");
              return (
                <EntityCard
                  id={`upstream-card-${index}`}
                  key={`upstream-${index}`}
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
                    <Field label={t("field.name", "Name")}><input value={item.name || ""} onChange={(event) => updateConfig((next) => { next.upstreams[index].name = event.target.value; })} /></Field>
                    <Field label={t("field.provider", "Provider")}><input value={item.provider || "azure-openai"} onChange={(event) => updateConfig((next) => { next.upstreams[index].provider = event.target.value; })} /></Field>
                    <Field label={t("field.status", "Status")}><select value={item.status || "active"} onChange={(event) => updateConfig((next) => { next.upstreams[index].status = event.target.value; })}><option value="active">{t("option.active", "active")}</option><option value="disabled">{t("option.disabled", "disabled")}</option></select></Field>
                    <Field label={t("field.priority", "Priority")}><input type="number" value={item.priority || 0} onChange={(event) => updateConfig((next) => { next.upstreams[index].priority = Number(event.target.value || 0); })} /></Field>
                  </div>
                  <Field label={t("field.baseUrl", "Base URL")}><input value={item.baseUrl || ""} onChange={(event) => updateConfig((next) => { next.upstreams[index].baseUrl = event.target.value; })} /></Field>
                  <Field label={t("field.capabilities", "Capabilities")}><input value={formatList(item.capabilities)} readOnly /></Field>
                </EntityCard>
              );
            })}
          </div>
        </div>

        <div id="routing-models">
          <h3 className="subhead">{t("entity.models", "Models")}</h3>
          <div className="entity-grid">
            {filteredModels.map(({ item, index }) => {
              const statusLabel = t(`option.${item.status || "active"}`, item.status || "active");
              const matchedTemplate = findPricingTemplateForModel(templateOptions, item);
              const wildcardRoute = typeof item?.routes?.["*"] === "string" ? item.routes["*"].trim() : "";
              const routeOptions = getSuggestedModelRouteValues(matchedTemplate || item);
              const hasCustomRoute = wildcardRoute && !isKnownModelRouteValue(wildcardRoute);
              const allRouteOptions = hasCustomRoute ? [wildcardRoute, ...routeOptions] : routeOptions;
              return (
                <EntityCard
                  id={`model-card-${index}`}
                  key={`model-${index}`}
                  title={item.displayName || item.id || `model-${index + 1}`}
                  subtitle={item.upstream || t("status.modelSubtitleFallback", "Upstream not bound")}
                  meta={`${t("routing.field.azureDeployment", "Azure Deployment Name")}: ${item.targetModel || "-"} · ${t("field.status", "Status")}: ${statusLabel}`}
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
                    ><input value={item.id || ""} onChange={(event) => updateConfig((next) => { next.models[index].id = event.target.value; autoMatchTemplate(next, index); })} /></Field>
                    <Field label={t("field.displayName", "Display Name")}><input value={item.displayName || ""} onChange={(event) => updateConfig((next) => { next.models[index].displayName = event.target.value; })} /></Field>
                    <Field label={t("routing.template.field", "Template")}>
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
                        {upstreamOptions.map((upstream) => <option key={upstream.name} value={upstream.name}>{upstream.name}</option>)}
                      </select>
                    </Field>
                    <Field label={t("field.defaultRoute", "Default Route")}>
                      <select value={wildcardRoute} onChange={(event) => updateConfig((next) => { setModelWildcardRoute(next, index, event.target.value); })}>
                        <option value="">{t("routing.route.auto", "Use template default")}</option>
                        {allRouteOptions.map((routeValue) => (
                          <option key={routeValue} value={routeValue}>
                            {hasCustomRoute && routeValue === wildcardRoute
                              ? `${t("routing.route.custom", "Custom")}: ${routeValue}`
                              : getRouteOptionLabel(t, routeValue)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("field.status", "Status")}><select value={item.status || "active"} onChange={(event) => updateConfig((next) => { next.models[index].status = event.target.value; })}><option value="active">{t("option.active", "active")}</option><option value="disabled">{t("option.disabled", "disabled")}</option></select></Field>
                    <Field
                      label={t("routing.field.pricingTemplateId", "Pricing Template ID")}
                      hint={t("routing.hint.pricingTemplateId", "Used to match pricing library metadata and governance pricing, not the Azure deployment name.")}
                    ><input value={item.pricingRef || ""} onChange={(event) => updateConfig((next) => { next.models[index].pricingRef = event.target.value; autoMatchTemplate(next, index); })} /></Field>
                  </div>
                  <Field label={t("field.capabilities", "Capabilities")}><input value={formatList(item.capabilities)} onChange={(event) => updateConfig((next) => {
                    next.models[index].capabilities = parseList(event.target.value);
                    syncUpstreamCapabilities(next, next.models[index].upstream);
                  })} /></Field>
                  <Field label={t("field.accessTags", "Access Tags")}><input value={formatList(item.accessTags)} onChange={(event) => updateConfig((next) => { next.models[index].accessTags = parseList(event.target.value); })} /></Field>
                </EntityCard>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}