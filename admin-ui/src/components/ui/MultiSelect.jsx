import { Combobox } from "@base-ui/react/combobox";

export default function MultiSelect({ label, items, value, onChange, itemLabel = item => item, t }) {
  return <Combobox.Root multiple items={items} value={value} onValueChange={onChange} itemToStringLabel={itemLabel}>
    <Combobox.Chips className="multi-chips">
      <Combobox.Value>{values => values.map(item => <Combobox.Chip key={item} className="multi-chip">
        {item}<Combobox.ChipRemove aria-label={`${t("entity.delete")} ${item}`}>×</Combobox.ChipRemove>
      </Combobox.Chip>)}</Combobox.Value>
      <Combobox.Input aria-label={label} placeholder={t("ui.search")} />
    </Combobox.Chips>
    <Combobox.Portal><Combobox.Positioner className="multi-positioner" sideOffset={4}>
      <Combobox.Popup className="multi-popup"><Combobox.Empty>{t("ui.emptySelection")}</Combobox.Empty>
        <Combobox.List>{item => <Combobox.Item key={item} value={item} className="multi-option">{itemLabel(item)}<Combobox.ItemIndicator> ✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List>
      </Combobox.Popup>
    </Combobox.Positioner></Combobox.Portal>
  </Combobox.Root>;
}
