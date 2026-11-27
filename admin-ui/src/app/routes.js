export const pages = [
  { id: "overview", group: "overview", path: "/overview", legacy: "runtime", sections: ["runtime-signals"] },
  { id: "channels", group: "models", path: "/channels", legacy: "routing" },
  { id: "models", group: "models", path: "/models", legacy: "routing" },
  { id: "clients", group: "models", path: "/clients", legacy: "harness" },
  { id: "catalog", group: "models", path: "/catalog", legacy: "ops", sections: ["ops-pricing", "workspace-pricing"] },
  { id: "keys", group: "access", path: "/keys", legacy: "keys" },
  { id: "usage", group: "observe", path: "/usage", legacy: "runtime", sections: ["runtime-overview", "runtime-models", "runtime-keys", "runtime-analytics", "runtime-signals"] },
  { id: "logs", group: "observe", path: "/logs", legacy: "ops", sections: ["ops-logs"] },
  { id: "health", group: "observe", path: "/health", legacy: "runtime", sections: ["runtime-persistence"] },
  { id: "playground", group: "tools", path: "/playground", legacy: "ops", sections: ["ops-test"] },
  { id: "diagnostics", group: "tools", path: "/diagnostics", legacy: "ops", sections: ["ops-model-validation"] },
  { id: "settings", group: "system", path: "/settings/service", legacy: "workspace" },
  { id: "config", group: "system", path: "/config/history", legacy: "advanced" }
];

export const settingsSections = {
  service: "workspace-core",
  proxy: "workspace-core",
  access: "workspace-core",
  persistence: "workspace-persistence",
  logging: "workspace-logging",
  media: "workspace-media",
  routing: "workspace-routing",
  gateway: "ops-caddy"
};

export function resolvePage(pathname) {
  const id = pathname.split("/").filter(Boolean)[0] || "overview";
  return pages.find(page => page.id === id) || null;
}
