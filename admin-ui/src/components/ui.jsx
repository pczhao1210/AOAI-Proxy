import { useEffect, useId, useRef } from "react";

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

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

export function EntityCard({ id, title, subtitle, onRemove, removeLabel, expandLabel = "Edit configuration", collapseLabel = "Collapse", children, collapsible = false, defaultOpen = true, meta, group }) {
  if (collapsible) {
    return (
      <details id={id} className="entity-card entity-card-collapsible" open={defaultOpen} data-accordion-group={group} onToggle={handleSingleOpenToggle}>
        <summary className="entity-summary">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
            {meta ? <div className="entity-meta">{meta}</div> : null}
          </div>
          <span className="entity-summary-action">
            <span className="entity-action-expand">{expandLabel}</span>
            <span className="entity-action-collapse">{collapseLabel}</span>
          </span>
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

export function Modal({ title, isOpen, onClose, onConfirm, confirmLabel, cancelLabel = "Cancel", closeLabel = "Close", children, disabled }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return undefined;

    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialogRef.current || document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal-content" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={closeLabel}>&times;</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
        <div className="modal-footer">
          <button type="button" className="ghost" onClick={onClose}>{cancelLabel}</button>
          <button type="button" onClick={onConfirm} disabled={disabled}>{confirmLabel || "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}
