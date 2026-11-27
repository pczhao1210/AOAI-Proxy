import { Link } from "react-router";
import { formatRuntimeNumber } from "../../utils.js";

export default function OverviewLists({ models, keys, validation, t }) {
  return <section className="overview-lists">
    {[["models", models], ["keys", keys]].map(([type, values]) => <div className="panel" key={type}>
      <h2>{t(`ui.top.${type}`)}</h2>
      <ol>{Object.entries(values || {}).filter(([, value]) => Number.isFinite(value.requests))
        .sort((a, b) => b[1].requests - a[1].requests).slice(0, 5).map(([id, value]) => <li key={id}>
          <Link to={type === "keys" ? `/usage?key=${encodeURIComponent(id)}&tab=keys` : "/usage?group=public"}>{id}</Link>
          <span>{formatRuntimeNumber(value.requests)}</span>
        </li>)}</ol>
      {!Object.keys(values || {}).length ? <p>{t("table.noData")}</p> : null}
      <Link to={`/usage?tab=${type}`}>{t("shell.page.usage")}</Link>
    </div>)}
    {validation?.summary?.failed > 0 ? <p role="status"><Link to="/diagnostics">{t("ui.validationAttention")}: {validation.summary.failed}</Link></p> : null}
  </section>;
}
