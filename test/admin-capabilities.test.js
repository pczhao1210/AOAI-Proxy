import assert from "node:assert/strict";
import test from "node:test";
import { fireEvent, renderAdminComponent, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

const config = {
  upstreams: [{ name: "provider", capabilities: ["stale"] }],
  models: [{ id: "public", upstream: "provider", capabilities: ["reasoning"], routes: {} }]
};
const capabilityView = {
  models: [{ modelId: "public", source: "catalog", capabilities: ["reasoning", "vision"],
    configuredCapabilities: ["reasoning"], configurationMismatch: true }],
  upstreams: [{ name: "provider", capabilities: ["reasoning", "vision"] }]
};
const props = {
  config, pricingLibrary: [], capabilityView, capabilitiesLoading: false, capabilitiesError: "",
  capabilityPreview: true, t: (_key, fallback) => fallback,
  addModel() {}, addBlankModel() {}, addUpstream() {}
};

test("routing displays effective Catalog capabilities and draft upstream summaries without rewriting stored values", async () => {
  const changes = [];
  const view = await renderAdminComponent("/admin-ui/src/components/RoutingTab.jsx", {
    ...props, updateConfig: change => changes.push(change)
  });
  for (const details of view.container.querySelectorAll("details")) details.open = true;
  const effective = view.getByRole("textbox", { name: /Effective capabilities/ });
  assert.equal(effective.value, "reasoning, vision");
  assert.equal(effective.readOnly, true);
  assert.equal(view.getByRole("textbox", { name: /Combined model capabilities/ }).value, "reasoning, vision");
  assert.equal(view.getByRole("textbox", { name: /Stored configuration labels/ }).value, "reasoning");
  assert.ok(view.getByText("Draft preview (not saved)"));
  assert.ok(view.getByText(/Source: Model Catalog/));
  assert.deepEqual(changes, []);
});

test("legacy capability fallback stays editable while unavailable or failed previews never expose stale facts", async () => {
  let nextConfig;
  const view = await renderAdminComponent("/admin-ui/src/components/RoutingTab.jsx", {
    ...props, capabilityPreview: false,
    capabilityView: { ...capabilityView, models: [{ ...capabilityView.models[0], source: "model-config", configurationMismatch: false }] },
    updateConfig: change => { nextConfig = structuredClone(config); change(nextConfig); }
  });
  for (const details of view.container.querySelectorAll("details")) details.open = true;
  const input = view.getByRole("textbox", { name: /Legacy configuration capabilities/ });
  assert.equal(input.readOnly, false);
  fireEvent.change(input, { target: { value: "reasoning, function-calling" } });
  assert.deepEqual(nextConfig.models[0].capabilities, ["reasoning", "function-calling"]);
  assert.deepEqual(config.models[0].capabilities, ["reasoning"]);
  view.unmount();
  const failed = await renderAdminComponent("/admin-ui/src/components/RoutingTab.jsx", {
    ...props, capabilityView: null, capabilitiesError: "Catalog unavailable", updateConfig() {}
  });
  for (const details of failed.container.querySelectorAll("details")) details.open = true;
  assert.ok(failed.getByRole("alert").textContent.includes("Catalog unavailable"));
  assert.equal(failed.getByRole("textbox", { name: /Effective capabilities/ }).disabled, true);
  assert.equal(failed.getByRole("textbox", { name: /Combined model capabilities/ }).value, "");
});

test("legacy capability editing remains available while its unchanged binding preview is refreshed", async () => {
  const view = await renderAdminComponent("/admin-ui/src/components/RoutingTab.jsx", {
    ...props, capabilityView: null, capabilitiesLoading: true, capabilityFallbackModels: ["public"], updateConfig() {}
  });
  for (const details of view.container.querySelectorAll("details")) details.open = true;
  const input = view.getByRole("textbox", { name: /Legacy configuration capabilities/ });
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, false);
  assert.equal(input.value, "reasoning");
  assert.equal(view.getByRole("textbox", { name: /Effective capabilities/ }).value, "");
});
