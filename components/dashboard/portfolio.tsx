"use client";
import Decimal from "decimal.js";
import { MoneyValue } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/data-table";
import type { Holding } from "./types";
export function Portfolio({ holdings, total, asOf }: { holdings: Holding[]; total: string | null; asOf: string }) {
  return <section className="portfolio-panel"><header className="panel-header"><div><h2>Investment portfolio</h2><p>Illustrative values · {asOf}</p></div><div className="portfolio-total"><span>Present value</span><strong><MoneyValue value={total} /></strong></div></header>
    <div className="portfolio-allocation"><div className="allocation-bar" aria-hidden="true" hidden={holdings.some(row => row.value === null)}>{holdings.map(row => <span key={row.id} className={`tone-${row.tone}`} style={{ width: row.allocation }} />)}</div>
      <dl className="allocation-legend">{holdings.map(row => <div key={row.id}><dt><span className={`color-key tone-${row.tone}`} />{row.name}</dt><dd>{row.allocation}</dd></div>)}</dl></div>
    <DataTable rows={holdings} caption="Investment values and expandable valuation details" sortColumn="value" compare={(a, b, ascending) => {
      // Display ordering only, no financial calculation. Unknowns always sort last.
      if (a.value === null) return b.value === null ? 0 : 1;
      if (b.value === null) return -1;
      return new Decimal(a.value).comparedTo(b.value) * (ascending ? 1 : -1);
    }} columns={[
      { id: "name", label: "Investment", render: row => <div className="holding-name"><strong>{row.name}</strong><span>{row.count}</span></div> },
      { id: "value", label: "Present value", render: row => <><strong><MoneyValue value={row.value} reason="Valuation missing" /></strong><small>Invested <MoneyValue value={row.invested} reason="Cost basis missing" /></small></> },
      { id: "allocation", label: "Allocation", render: row => <>{row.allocation}<small>of portfolio</small></> },
      { id: "movement", label: "This month", render: row => <strong className={row.movement.startsWith("−") ? "negative" : "positive"}>{row.movement}</strong> },
      { id: "return", label: "Total return", render: row => <strong className="positive">{row.totalReturn}</strong> },
    ]} details={row => <dl className="detail-grid">{Object.entries(row.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>} />
  </section>;
}
