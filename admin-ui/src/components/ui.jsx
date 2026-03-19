export function StatCard({ label, value, note }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

export function Section({ id, title, desc, children, actions }) {
  return (
    <section id={id} className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {desc ? <p>{desc}</p> : null}
        </div>
        {actions ? <div className="toolbar">{actions}</div> : null}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

function handleSingleOpenToggle(event) {
  const current = event.currentTarget;
  const group = current.dataset.accordionGroup;
  if (!group || !current.open) return;

  document.querySelectorAll(`details[data-accordion-group="${group}"]`).forEach((item) => {
    if (item !== current && item instanceof HTMLDetailsElement) {
      item.open = false;
    }
  });
}

export function AccordionSection({ id, title, desc, children, defaultOpen = false, group }) {
  return (
    <details id={id} className="accordion-section" open={defaultOpen} data-accordion-group={group} onToggle={handleSingleOpenToggle}>
      <summary className="accordion-summary">
        <div className="accordion-copy">
          <h3>{title}</h3>
          {desc ? <p>{desc}</p> : null}
        </div>
        <span className="accordion-arrow" aria-hidden="true">+</span>
      </summary>
      <div className="accordion-body">{children}</div>
    </details>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

export function EntityCard({ id, title, subtitle, onRemove, removeLabel, children, collapsible = false, defaultOpen = true, meta, group }) {
  if (collapsible) {
    return (
      <details id={id} className="entity-card entity-card-collapsible" open={defaultOpen} data-accordion-group={group} onToggle={handleSingleOpenToggle}>
        <summary className="entity-summary">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
            {meta ? <div className="entity-meta">{meta}</div> : null}
          </div>
          <span className="entity-summary-action">展开配置</span>
        </summary>
        <div className="entity-toolbar">
          <button type="button" className="ghost danger" onClick={onRemove}>{removeLabel}</button>
        </div>
        <div className="entity-body">{children}</div>
      </details>
    );
  }

  return (
    <article id={id} className="entity-card">
      <div className="entity-head">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button type="button" className="ghost danger" onClick={onRemove}>{removeLabel}</button>
      </div>
      <div className="entity-body">{children}</div>
    </article>
  );
}

export function TabButton({ active, onClick, children }) {
  return (
    <button type="button" className={active ? "tab-button active" : "tab-button"} onClick={onClick}>
      {children}
    </button>
  );
}

export function Modal({ title, isOpen, onClose, onConfirm, confirmLabel, children, disabled }) {
  if (!isOpen) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
        <div className="modal-footer">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={disabled}>{confirmLabel || "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}
