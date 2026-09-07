import { after, afterEach, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { JSDOM } from "jsdom";
import { setValueByPath } from "../../admin-ui/src/utils.js";

let vite;
let dom;
let React;
let WorkspaceTab;
let render;
let within;
let cleanup;
export let fireEvent;
const originalGlobals = new Map();

export function setupWorkspaceFormTests() {
  before(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDetailsElement", "Node", "MutationObserver"]) {
      originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
    }
    React = await import("react");
    ({ render, fireEvent, within, cleanup } = await import("@testing-library/react/pure.js"));
    vite = await createServer({
      configFile: fileURLToPath(new URL("../../admin-ui/vite.config.js", import.meta.url)),
      root: fileURLToPath(new URL("../..", import.meta.url)),
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
}

export function renderWorkspace(config, sectionId = "workspace-media") {
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
  const section = view.container.querySelector(`#${sectionId}`);
  section.open = true;
  return { ...view, section, fields: within(section), changes, updateConfig };
}