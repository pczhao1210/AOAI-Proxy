import { Field, ListInput } from "../../components/ui.jsx";
import { isCopilotChannel } from "../../copilot.js";

export default function RoutePolicyEditor({ item, channels, tab, update, t }) {
  const deployment = !channels && item.selectedBinding ? item.bindingOverride || {} : item;
  const policy = item.requestPolicy || {};
  const setPolicy = (field, value) => update(next => {
    next.requestPolicy = { ...next.requestPolicy, [field]: value };
  });
  if (tab === "routes") return <>
    <p className="field-hint">{t(channels ? "ui.routePathsHelp" : "ui.routeTargetsHelp")}</p>
    <div className="form-grid">
      {[...new Set(["chat/completions", "responses", "messages", ...Object.keys(deployment.routes || {})])].map(route => <Field key={route} label={route}>
        <input readOnly={channels && isCopilotChannel(item)} value={deployment.routes?.[route] ?? ""} onChange={event => {
          const value = event.target.value;
          update(next => {
            const target = !channels && next.selectedBinding
              ? next.bindingOverride ||= { ...next.selectedBinding } : next;
            target.routes = { ...target.routes };
            if (value) target.routes[route] = value; else delete target.routes[route];
          });
        }} />
      </Field>)}
    </div>
  </>;
  return <div className="stack-lg">
    <Field label={t("ui.allowedParams")}><ListInput value={policy.allowedParams} onChange={value => setPolicy("allowedParams", value)} /></Field>
    <Field label={t("ui.blockedParams")}><ListInput value={policy.blockedParams} onChange={value => setPolicy("blockedParams", value)} /></Field>
    <label><input type="checkbox" checked={policy.dropUnsupportedParams === true} onChange={event => setPolicy("dropUnsupportedParams", event.target.checked)} />{t("ui.dropUnsupportedParams")}</label>
    {channels ? <Field label={t("ui.nativeErrorPassthrough")}><select value={item.errorPolicy?.nativePassthrough == null ? "" : String(item.errorPolicy.nativePassthrough)} onChange={event => {
      const value = event.target.value;
      update(next => {
        next.errorPolicy = { ...next.errorPolicy };
        if (value === "") delete next.errorPolicy.nativePassthrough;
        else next.errorPolicy.nativePassthrough = value === "true";
      });
    }}><option value="">{t("ui.inherit")}</option><option value="true">{t("common.yes")}</option><option value="false">{t("common.no")}</option></select></Field> : null}
  </div>;
}
