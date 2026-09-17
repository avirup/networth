import { ChartFrame, MoneyValue } from "@/components/ui/primitives";
import type { DashboardSnapshot } from "./types";
export function CashBalances({ rows }: { rows: DashboardSnapshot["cash"] }) {
  return <ChartFrame title="Cash by account" description="Illustrative balances · shared ₹3,00,000 scale"><ul className="balance-list">{rows.map(row => <li key={row.name}><div><strong>{row.name}</strong><MoneyValue value={row.value} /></div><div className="balance-track" aria-hidden="true"><span className={`tone-${row.tone}`} style={{ width: `${row.width}%` }} /></div></li>)}</ul></ChartFrame>;
}
export function CreditUtilization({ rows }: { rows: DashboardSnapshot["credit"] }) {
  return <ChartFrame title="Credit card utilisation" description="Amount used / total limit · fixed 0–100% scale"><ul className="balance-list">{rows.map(row => <li key={row.name}><div><strong>{row.name}</strong><span>{row.percent}% used</span></div><meter className={`tone-${row.tone}`} min="0" max="100" value={row.percent} aria-label={`${row.name} utilisation`} />
    <p className="balance-caption"><MoneyValue value={row.used} /> used <span>Limit <MoneyValue value={row.limit} /></span></p></li>)}</ul></ChartFrame>;
}
