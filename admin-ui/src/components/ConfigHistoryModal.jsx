import { useEffect, useRef, useState } from "react";
import { fetchConfigHistory } from "../api.js";
import { buildConfigDiffPreview, computeConfigDiff, formatDateTime } from "../utils.js";
import { Modal } from "./ui.jsx";
import ReviewChanges from "./ReviewChanges.jsx";

function HistoryPanel({ title, children, onClose, onConfirm, disabled, confirmLabel, cancelLabel }) {
  return <section className="panel config-history" aria-label={title}>
    {children}
    <div className="toolbar"><button className="ghost" onClick={onClose}>{cancelLabel}</button>
      <button onClick={onConfirm} disabled={disabled}>{confirmLabel}</button></div>
  </section>;
}

export default function ConfigHistoryModal({ isOpen, embedded = false, onClose, config, onRestore, saving, t }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState("");
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    if (!isOpen) return;
    setLoading(true);
    setSelected("");
    setEntry(null);
    setError("");
    fetchConfigHistory().then(result => {
      if (request.current === id) setItems(result.items);
    }).catch(failure => {
      if (request.current === id) setError(failure.message);
    }).finally(() => {
      if (request.current === id) setLoading(false);
    });
    return () => { request.current++; };
  }, [isOpen]);

  async function selectEntry(id) {
    const sequence = ++request.current;
    setSelected(id);
    setEntry(null);
    setError("");
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await fetchConfigHistory(id);
      if (request.current === sequence) setEntry(result.entry);
    } catch (failure) {
      if (request.current === sequence) setError(failure.message);
    } finally {
      if (request.current === sequence) setLoading(false);
    }
  }

  const Container = embedded ? HistoryPanel : Modal;
  return <Container
    title={t("config.history.title", "Configuration history")}
    isOpen={isOpen} onClose={onClose} onConfirm={async () => {
      try {
        await onRestore(selected);
      } catch (failure) {
        setError(failure.message);
      }
    }}
    confirmLabel={t("config.history.restore", "Restore as new revision")}
    cancelLabel={t("common.cancel", "Cancel")} closeLabel={t("common.close", "Close")}
    disabled={loading || saving || !entry}
  >
    <p>{t("config.history.description", "The latest 12 redacted versions are retained. Restore keeps current credentials and storage settings, creates a new revision, and replaces your draft. Removed credentials cannot be recovered.")}</p>
    {embedded && items.length ? <div className="table-scroll"><table>
      <thead><tr><th>{t("config.history.version", "Historical version")}</th><th>{t("logs.configRevision")}</th><th>{t("logs.meta.time", "Time")}</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.id}>
        <td><button className="table-link" disabled={saving} onClick={() => selectEntry(item.id)}>{item.actor} · {t(`config.history.${item.action}`, item.action)}</button></td>
        <td><code>{item.revision || "—"}</code></td><td>{formatDateTime(item.createdAt)}</td>
      </tr>)}</tbody>
    </table></div> : null}
    {!loading && !error && !items.length ? <p className="empty-state">{t("ui.noRows")}</p> : null}
    <label className="field">
      <span>{t("config.history.version", "Historical version")}</span>
      <select value={selected} onChange={event => selectEntry(event.target.value)} disabled={saving}>
        <option value="">{t("config.history.select", "Select a version")}</option>
        {items.map(item => <option key={item.id} value={item.id}>{formatDateTime(item.createdAt)} · {item.actor} · {t(`config.history.${item.action}`, item.action)}</option>)}
      </select>
    </label>
    {loading ? <p>{t("config.conflict.loading", "Loading...")}</p> : null}
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {entry && embedded ? <ReviewChanges before={config || {}} after={entry.config} t={t} /> : null}
    {entry ? <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: "300px", overflowY: "auto" }}>
      {buildConfigDiffPreview(computeConfigDiff(config || {}, entry.config), t, Infinity)}
    </pre> : null}
  </Container>;
}
