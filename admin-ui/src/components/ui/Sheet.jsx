import { Dialog } from "@base-ui/react/dialog";

export default function Sheet({ open, title, children, onClose, onCancel, onApply, disabled, t }) {
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="ui-backdrop" />
      <Dialog.Popup className="entity-sheet">
        <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="ghost" aria-label={t("common.close")}>×</Dialog.Close></header>
        <div className="sheet-body">{children}</div>
        <footer>
          <button className="ghost" onClick={onCancel}>{t("common.cancel")}</button>
          {onApply ? <button disabled={disabled} onClick={onApply}>{t("ui.applyDraft")}</button> : null}
        </footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
