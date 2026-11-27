import { useEffect } from "react";
import { useSearchParams } from "react-router";
import LogTable, { LogDetail } from "../../components/LogTable.jsx";
import Sheet from "../../components/ui/Sheet.jsx";

export default function LogExplorer(props) {
  const [params, setParams] = useSearchParams();
  const id = entry => String(entry.id ?? `${entry.requestId}:${entry.ts}:${entry.event}`);
  const selected = params.get("detail");
  const index = props.items.findIndex(entry => id(entry) === selected);
  const entry = props.items[index];
  const open = entry => setParams(current => {
    const next = new URLSearchParams(current);
    if (entry) next.set("detail", id(entry)); else next.delete("detail");
    return next;
  });
  useEffect(() => {
    if (!entry) return;
    const keydown = event => {
      if (event.target.closest("input, textarea, select") || event.ctrlKey || event.altKey || event.metaKey) return;
      const next = event.key === "j" ? props.items[index + 1] : event.key === "k" ? props.items[index - 1] : null;
      if (next) { event.preventDefault(); open(next); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [selected, props.items]);
  return <>
    <LogTable {...props} onOpenDetails={open} />
    {selected && !entry ? <p role="status">{props.t("ui.entityMissing")}</p> : null}
    <Sheet open={Boolean(entry)} title={entry?.requestId || props.t("ui.details")} t={props.t} onClose={() => open(null)} onCancel={() => open(null)}>
      {entry ? <>
        <div className="toolbar">
          <button className="ghost" disabled={index <= 0} onClick={() => open(props.items[index - 1])}>{props.t("ui.previous")}</button>
          <button className="ghost" disabled={index >= props.items.length - 1} onClick={() => open(props.items[index + 1])}>{props.t("ui.next")}</button>
          <button className="ghost" onClick={() => props.onCopyLogSummary(entry)}>{props.t("logs.copySummary")}</button>
        </div>
        <h3>{props.t("ui.routeChain")}</h3>
        <p>{["consumerKeyId", "modelId", "canonicalModelId", "channelId", "sourceModelId", "backendRouteKey", "actualModelName"]
          .map(key => entry[key] || entry.fields?.[key] || entry.events?.findLast(event => event[key])?.[key] || props.t("ui.unknown")).join(" → ")}</p>
        <LogDetail entry={entry} requestView={props.view === "requests"} helpers={props} />
        <p className="muted">{props.t("ui.bodyUnavailable")}</p>
      </> : null}
    </Sheet>
  </>;
}
