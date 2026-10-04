import type { ReactNode } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/presentation/format";
import { PRODUCT_NAME } from "@/lib/presentation/product";

export function Brand({ href = "/login" }: { href?: string }) {
  return <Link className="brand" href={href} aria-label={`${PRODUCT_NAME} home`}><span className="brand-mark" aria-hidden="true" /><span className="brand-name">{PRODUCT_NAME}</span></Link>;
}
export function MoneyValue({ value, reason = "Value not available", fractionDigits = 0 }: { value: string | null; reason?: string; fractionDigits?: number }) {
  return value === null ? <span className="money unknown" aria-label={`Unknown: ${reason}`} title={reason}>—<span className="sr-only"> {reason}</span></span>
    : <span className="money" title={formatMoney(value, value.split(".")[1]?.length ?? 0)}>{formatMoney(value, fractionDigits)}</span>;
}
export type Quality = "complete" | "incomplete" | "stale" | "paused";
const qualityLabels: Record<Quality, string> = { complete: "Complete report", incomplete: "Incomplete data", stale: "Last available report", paused: "Updates paused" };
export function DataQualityIndicator({ state, label, children }: { state: Quality; label?: string; children?: ReactNode }) {
  return <div className={`quality quality-${state}`} role="status"><strong>{label ?? qualityLabels[state]}</strong>{children && <span>{children}</span>}</div>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function ErrorState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state error-state" role="alert"><h2>This report couldn’t be loaded</h2><p>{children}</p>{action}</div>;
}
export function LoadingState() {
  return <div className="loading-state" role="status" aria-live="polite"><span className="loading-dot" aria-hidden="true" />Loading your report…</div>;
}
export function ChartFrame({ title, description, summary, children }: { title: string; description: string; summary?: ReactNode; children: ReactNode }) {
  return <section className="chart-frame"><header className="panel-header"><div><h2>{title}</h2><p>{description}</p></div>{summary && <strong>{summary}</strong>}</header>{children}</section>;
}
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return <details className="disclosure"><summary>{title}</summary><div>{children}</div></details>;
}
export function AccessLayout({ title, children }: { title: string; children: ReactNode }) {
  return <main className="access-layout"><Brand /><section className="access-panel"><h1>{title}</h1>{children}</section><p className="access-note">A private place for your household’s finances.</p></main>;
}
