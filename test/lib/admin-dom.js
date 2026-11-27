import { JSDOM } from "jsdom";

export function installAdminDom(url = "http://localhost/admin/") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url, pretendToBeVisual: true });
  const originals = new Map();
  const required = new Set(["window", "document", "navigator"]);
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis && !required.has(name)) continue;
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  }
  return {
    window: dom.window,
    restore() {
      dom.window.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}
