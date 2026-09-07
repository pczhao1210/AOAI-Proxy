import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { JSDOM } from "jsdom";
import { setValueByPath } from "../admin-ui/src/utils.js";

let vite;
let dom;
let React;
let WorkspaceTab;
let render;
let fireEvent;
let within;
let cleanup;
const originalGlobals = new Map();

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDetailsElement", "Node", "MutationObserver"]) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  }
  React = await import("react");
  ({ render, fireEvent, within, cleanup } = await import("@testing-library/react/pure.js"));
  vite = await createServer({
    configFile: fileURLToPath(new URL("../admin-ui/vite.config.js", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { dedupe: ["react", "react-dom"] },
    server: { middlewareMode: true, watch: null, ws: false },
    appType: "custom"
  });
  ({ default: WorkspaceTab } = await vite.ssrLoadModule("/admin-ui/src/components/WorkspaceTab.jsx"));
});

afterEach(() => cleanup?.());
after(async () => {
  await vite?.close();
  dom?.window.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function mediaConfig({ enabled = true, mode = "adaptive", remote = false, generation = false } = {}) {
  return { media: {
    inputCompression: {
      enabled, mode, maxLongSidePx: 1600, quality: 0.85, minQuality: 0.1, outputFormat: "jpeg",
      minBytes: 0, minSavingsRatio: 0, maxPixels: 40000000, maxConcurrent: 2, maxQueue: 0, timeoutMs: 5000,
      progressive: false, useMozJpeg: true
    },
    remoteImages: { allow: remote, allowedHosts: ["images.example"], allowedMimeTypes: ["image/png"] },
    inlineImages: { maxBase64Bytes: 20971520, maxImages: 0, maxTotalBytes: 0, logPreviewChars: 0, redactInLogs: true },
    generation: { enabled: generation, defaultModel: "image-model", maxImages: 4 }
  } };
}

function renderWorkspace(config) {
  const changes = [];
  let currentConfig = config;
  const updateConfig = next => {
    currentConfig = next;
    view.rerender(React.createElement(WorkspaceTab, { ...props, config: currentConfig }));
  };
  const props = { config, updateField: (path, value) => {
    changes.push([path, value]);
    const next = structuredClone(currentConfig);
    setValueByPath(next, path, value);
    updateConfig(next);
  }, t: (_key, fallback) => fallback };
  const view = render(React.createElement(WorkspaceTab, props));
  const section = view.container.querySelector("#workspace-media");
  section.open = true;
  return { ...view, section, fields: within(section), changes, updateConfig };
}

test("media form keeps its navigation anchor, accordion group and four mode states", () => {
  const view = renderWorkspace(mediaConfig({ enabled: false }));
  assert.equal(view.section.tagName, "DETAILS");
  assert.equal(view.section.dataset.accordionGroup, "workspace-sections");
  assert.ok(view.section.classList.contains("accordion-section"));
  assert.equal(view.section.querySelectorAll(".form-grid").length, 1);
  assert.equal(view.section.querySelectorAll(".checkbox-row").length, 1);
  for (const scenario of [
    { enabled: false, mode: "adaptive", selector: false, quality: false, output: false, adaptive: false },
    { enabled: true, mode: "legacy", selector: true, quality: true, output: true, adaptive: false },
    { enabled: true, mode: "preserve", selector: true, quality: false, output: false, adaptive: false },
    { enabled: true, mode: "adaptive", selector: true, quality: true, output: false, adaptive: true }
  ]) {
    view.updateConfig(mediaConfig(scenario));
    for (const [label, present] of [
      ["Compression Mode", scenario.selector], ["Quality", scenario.quality],
      ["Output Format", scenario.output], ["Minimum Input Bytes", scenario.adaptive]
    ]) assert.equal(!!view.fields.queryByLabelText(label, { exact: true }), present, `${scenario.mode}: ${label}`);
    assert.ok(view.fields.getByLabelText("Inline Max Base64 Bytes"));
    assert.equal(view.section.querySelectorAll('input[type="checkbox"]').length, 6);
  }
  assert.deepEqual(view.changes, []);
});

test("media form preserves numeric zeros and maps adaptive inputs to exact configuration paths", () => {
  const view = renderWorkspace(mediaConfig());
  const fields = [
    ["Minimum Input Bytes", "minBytes", "0", 0],
    ["Minimum Savings Ratio", "minSavingsRatio", "0", 0],
    ["Decode Pixel Limit", "maxPixels", "40000000", 12000000],
    ["Concurrent Encoders", "maxConcurrent", "2", 3],
    ["Queue Capacity", "maxQueue", "0", 0],
    ["Preparation Budget ms", "timeoutMs", "5000", 6000]
  ];
  for (const [label, field, initial, expected] of fields) {
    const input = view.fields.getByLabelText(label, { exact: true });
    assert.equal(input.value, initial);
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.change(input, { target: { value: String(expected) } });
    assert.deepEqual(view.changes.at(-1), [`media.inputCompression.${field}`, expected]);
  }
  for (const [label, path] of [
    ["Image Count Limit (0 = unlimited)", "media.inlineImages.maxImages"],
    ["Total Inline Bytes (0 = unlimited)", "media.inlineImages.maxTotalBytes"]
  ]) {
    const input = view.fields.getByLabelText(label, { exact: true });
    assert.equal(input.value, "0");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.change(input, { target: { value: "" } });
    assert.deepEqual(view.changes.at(-1), [path, 0]);
  }
});

test("media mode changes preserve hidden settings and use the existing update callback", () => {
  const config = mediaConfig({ mode: "legacy" });
  const original = structuredClone(config);
  const view = renderWorkspace(config);
  fireEvent.change(view.fields.getByLabelText("Compression Mode"), { target: { value: "adaptive" } });
  assert.deepEqual(view.changes, [["media.inputCompression.mode", "adaptive"]]);
  view.updateConfig({ ...config, media: { ...config.media, inputCompression: { ...config.media.inputCompression, mode: "adaptive" } } });
  assert.equal(view.fields.getByLabelText("Queue Capacity").value, "0");
  view.updateConfig(config);
  assert.equal(view.fields.getByLabelText("Output Format").value, "jpeg");
  assert.deepEqual(config, original);
});

test("remote and generation fields retain their independent visibility and list parsing", () => {
  const view = renderWorkspace(mediaConfig());
  assert.equal(view.fields.queryByLabelText("Remote Allowed Hosts"), null);
  assert.equal(view.fields.queryByLabelText("Default Generation Model"), null);
  view.updateConfig(mediaConfig({ remote: true }));
  assert.ok(view.fields.getByLabelText("Remote Allowed Hosts"));
  assert.equal(view.fields.queryByLabelText("Default Generation Model"), null);
  view.updateConfig(mediaConfig({ generation: true }));
  assert.equal(view.fields.queryByLabelText("Remote Allowed Hosts"), null);
  assert.ok(view.fields.getByLabelText("Default Generation Model"));
  view.updateConfig(mediaConfig({ remote: true, generation: true }));
  for (const [label, path, value, expected] of [
    ["Remote Allowed Hosts", "media.remoteImages.allowedHosts", " first.example, second.example ", ["first.example", "second.example"]],
    ["Remote Allowed MIME Types", "media.remoteImages.allowedMimeTypes", "image/jpeg, image/png", ["image/jpeg", "image/png"]],
    ["Allowed Sizes", "media.generation.allowedSizes", "1024x1024, 1024x1536", ["1024x1024", "1024x1536"]],
    ["Allowed Quality Modes", "media.generation.allowedQualityModes", "high, auto", ["high", "auto"]],
    ["Default Generation Model", "media.generation.defaultModel", "new-model", "new-model"]
  ]) {
    fireEvent.change(view.fields.getByLabelText(label, { exact: true }), { target: { value } });
    assert.deepEqual(view.changes.at(-1), [path, expected]);
  }
});

test("media switches retain their exact boolean configuration paths", () => {
  const view = renderWorkspace(mediaConfig());
  for (const [label, path] of [
    ["Enable Input Compression", "media.inputCompression.enabled"],
    ["Progressive", "media.inputCompression.progressive"],
    ["Prefer mozjpeg", "media.inputCompression.useMozJpeg"],
    ["Allow Remote Images", "media.remoteImages.allow"],
    ["Redact Inline Image Logs", "media.inlineImages.redactInLogs"],
    ["Enable Image Generation Route", "media.generation.enabled"]
  ]) {
    const checkbox = view.fields.getByLabelText(label, { exact: true });
    const expected = !checkbox.checked;
    fireEvent.click(checkbox);
    assert.deepEqual(view.changes.at(-1), [path, expected]);
  }
});