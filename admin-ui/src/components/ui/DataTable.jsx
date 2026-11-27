import { useMemo, useState } from "react";
import { flexRender, getCoreRowModel, getExpandedRowModel, getGroupedRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";

export default function DataTable({ rows, columns, getRowId, label, t, onBulkStatus, groupBy }) {
  const [sorting, setSorting] = useState([]);
  const [selection, setSelection] = useState({});
  const [visibility, setVisibility] = useState({});
  const grouping = useMemo(() => groupBy ? [groupBy] : [], [groupBy]);
  const table = useReactTable({
    data: rows, columns, getRowId,
    state: { sorting, rowSelection: selection, columnVisibility: visibility, grouping, expanded: true },
    onSortingChange: setSorting, onRowSelectionChange: setSelection, onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    getGroupedRowModel: getGroupedRowModel(), getExpandedRowModel: getExpandedRowModel(),
    groupedColumnMode: false
  });
  const selected = table.getSelectedRowModel().rows;
  return <div className="data-table">
    <div className="table-options">
      {selected.length ? <div className="table-bulk" role="group" aria-label={t("ui.selectedCount", "{count} selected", { count: selected.length })}>
        <span>{t("ui.selectedCount", "{count} selected", { count: selected.length })}</span>
        {["active", "disabled"].map(status => <button key={status} className="ghost" onClick={() => {
          onBulkStatus(selected.map(row => row.original), status); setSelection({});
        }}>{t(status === "active" ? "ui.enable" : "ui.disable")}</button>)}
      </div> : null}
      <details className="column-picker"><summary>{t("ui.columns")}</summary><div>{table.getAllLeafColumns().map(column => <label key={column.id}>
        <input type="checkbox" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} /> {column.columnDef.header}
      </label>)}</div></details>
    </div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
      <table>
        <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>
          {onBulkStatus ? <th><input type="checkbox" aria-label={t("ui.selectAll")} checked={table.getIsAllRowsSelected()} onChange={table.getToggleAllRowsSelectedHandler()} /></th> : null}
          {group.headers.map(header => <th key={header.id} aria-sort={header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : "none"}>
            {header.column.getCanSort() ? <button className="table-sort" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())} {header.column.getIsSorted() === "asc" ? "↑" : header.column.getIsSorted() === "desc" ? "↓" : ""}</button> : flexRender(header.column.columnDef.header, header.getContext())}
          </th>)}
        </tr>)}</thead>
        <tbody>{table.getRowModel().rows.map(row => row.getIsGrouped() ? <tr key={row.id} className="table-group">
          <th scope="rowgroup" colSpan={table.getVisibleLeafColumns().length + (onBulkStatus ? 1 : 0)}>{row.groupingValue} · {row.subRows.length}</th>
        </tr> : <tr key={row.id}>
          {onBulkStatus ? <td><input type="checkbox" aria-label={t("ui.selectRow", "Select {name}", { name: row.id })} checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} /></td> : null}
          {row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
        </tr>)}</tbody>
      </table>
      {!rows.length ? <p className="empty-state">{t("ui.noRows")}</p> : null}
    </div>
  </div>;
}
