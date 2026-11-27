import { createContext, useContext } from "react";
import { getValueByPath } from "../utils.js";

const Context = createContext(null);
export const SettingsFieldsProvider = Context.Provider;

export function useSettingsField(path, label) {
  const settings = useContext(Context);
  if (!settings || !path) return null;
  const metadataPath = Object.keys(settings.metadata || {}).filter(key => path === key || path.startsWith(`${key}.`))
    .sort((a, b) => b.length - a.length)[0];
  const metadata = settings.metadata?.[metadataPath];
  const modified = JSON.stringify(getValueByPath(settings.config, path)) !== JSON.stringify(getValueByPath(settings.loadedConfig, path));
  const visible = (!settings.modifiedOnly || modified) && (!settings.search
    || `${path} ${typeof label === "string" ? label : ""}`.toLowerCase().includes(settings.search.toLowerCase()));
  const badge = metadata?.source === "environment" ? `${settings.t("ui.source.environment")}: ${metadata.variable}`
    : metadata?.source === "profile" ? `${settings.t("ui.source.profile")}: ${metadata.profile}`
      : metadata?.restartRequired ? settings.t("ui.source.restart")
        : settings.metadata ? settings.t("ui.source.hot") : settings.t("ui.unknown");
  return { visible, modified, badge, readOnly: metadata?.readOnly === true };
}
