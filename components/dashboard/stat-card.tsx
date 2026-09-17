import { MoneyValue } from "@/components/ui/primitives";
import type { Stat } from "./types";
export function StatCard({ stat }: { stat: Stat }) {
  return <article className={`kpi-card tone-${stat.tone}`}><h2 className="kpi-label">{stat.label}</h2><p className="kpi-value"><MoneyValue value={stat.value} /></p>
    <p className="kpi-change"><strong>{stat.change}</strong><span>vs previous month</span></p>
    {stat.trend && <svg className="sparkline" viewBox="0 0 360 108" role="img" aria-label={`${stat.label}: illustrative trend, ending at the displayed value. ${stat.change} versus previous month.`} preserveAspectRatio="none"><path d={stat.trend.path} /><circle cx="358" cy={stat.trend.endY} r="3" /></svg>}
  </article>;
}
