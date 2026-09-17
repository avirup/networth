"use client";
import { Fragment, useState, type ReactNode } from "react";
import { Icon } from "./icon";
export type Column<T> = { id: string; label: string; render: (row: T) => ReactNode };
/** Small, already-bounded report tables. Import paging/virtualization comes later. */
export function DataTable<T extends { id: string; name: string }>({ rows, columns, caption, sortColumn, compare, details }: {
  rows: T[]; columns: Column<T>[]; caption: string; sortColumn: string; compare: (a: T, b: T, ascending: boolean) => number; details: (row: T) => ReactNode;
}) {
  const [ascending, setAscending] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return <><div className="table-toolbar"><button className="text-button" onClick={() => setAscending(!ascending)} aria-label={`Sort present value ${ascending ? "descending" : "ascending"}`}>Present value <Icon className={ascending ? "rotate-up" : ""} name="down" /></button><span className="sr-only" aria-live="polite">Sorted {ascending ? "ascending" : "descending"}</span></div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}><table className="data-table"><caption className="sr-only">{caption}</caption><thead><tr>{columns.map(column => <th key={column.id} scope="col" aria-sort={column.id === sortColumn ? ascending ? "ascending" : "descending" : undefined}>{column.label}</th>)}</tr></thead>
      <tbody>{[...rows].sort((a, b) => compare(a, b, ascending)).map(row => <Fragment key={row.id}><tr className="data-row">{columns.map((column, index) => <td key={column.id} data-label={column.label}>{index === 0 ? <div className="row-name"><button className="row-toggle icon-button" aria-label={`${expanded.has(row.id) ? "Hide" : "Show"} ${row.name} details`} aria-expanded={expanded.has(row.id)} aria-controls={`details-${row.id}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}><Icon name="chevron" /></button>{column.render(row)}</div> : column.render(row)}</td>)}</tr>
        <tr id={`details-${row.id}`} hidden={!expanded.has(row.id)} className="detail-row"><td colSpan={columns.length}>{details(row)}</td></tr></Fragment>)}</tbody></table></div></>;
}
