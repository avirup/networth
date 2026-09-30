"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useReportPeriod } from "@/components/auth/period-context";
import { DataQualityIndicator, EmptyState, ErrorState, LoadingState, MoneyValue } from "@/components/ui/primitives";
import type { BankOverview } from "@/db/reports/service";

export function BankOverviewReport() {
  const period = useReportPeriod();
  const [state, setState] = useState<{ period: string; report: BankOverview | null; error: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/reports/overview?month=${encodeURIComponent(period)}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<BankOverview | null>; })
      .then(report => setState({ period, report, error: false })).catch(cause => { if (cause?.name !== "AbortError") setState({ period, report: null, error: true }); });
    return () => controller.abort();
  }, [period]);
  const current = state?.period === period ? state : null;
  if (!current) return <LoadingState />;
  if (current.error) return <ErrorState action={<button className="text-button" onClick={() => location.reload()}>Reload report</button>}>The published release could not be read. Reload the page; your last published data remains unchanged.</ErrorState>;
  const report = current.report;
  if (report === null) return <EmptyState title="No published report yet" action={<Link className="button" href="/dashboard/imports">Import a bank statement</Link>}>Confirm an import and let the calculation workflow publish its first complete banking release.</EmptyState>;
  const incomplete = report.summary.unknownAccountCount > 0;
  return <div className="live-report" data-report-release={report.release.id}>
    <DataQualityIndicator state={incomplete ? "incomplete" : "complete"}>{incomplete ? `${report.summary.unknownAccountCount} account${report.summary.unknownAccountCount === 1 ? "" : "s"} ${report.summary.unknownAccountCount === 1 ? "has" : "have"} an unavailable value; known totals exclude it.` : `Published through ${report.release.asOf}.`}</DataQualityIndicator>
    <section className="kpi-grid" aria-label="Published banking summary">
      <ReportMetric label="Known net worth" value={report.summary.netWorthInr} note="Reconciled INR bank and cash positions" tone="cobalt" />
      <ReportMetric label="Income this month" value={report.summary.monthlyIncomeInr} note="Transfers and repayments excluded" tone="violet" />
      <ReportMetric label="Expenses this month" value={report.summary.monthlyExpenseInr} note="Reviewed expense categories" tone="coral" />
    </section>
    <div className="published-grid">
      <section className="chart-frame"><header className="panel-header"><div><h2>Accounts</h2><p>Balances as of {report.release.asOf}</p></div><strong>Source revision {report.release.sourceRevision}</strong></header>
        <ul className="report-account-list">{report.accounts.map(account => <li key={account.id}><div><strong>{account.name}</strong><span>{account.currency} · {account.status}</span></div><AccountBalance currency={account.currency} value={account.reconciledBalance} reason={account.reasons.join("; ") || "Balance is incomplete"} /></li>)}</ul></section>
      <section className="chart-frame"><header className="panel-header"><div><h2>Income and expenses</h2><p>{period} · exact published category totals</p></div></header>
        {report.categories.length ? <ul className="report-category-list">{report.categories.map(row => <li key={`${row.kind}:${row.category}`}><div><strong>{row.category}</strong><span>{row.kind} · {row.postingCount} posting{row.postingCount === 1 ? "" : "s"}</span></div><MoneyValue value={row.amountInr} fractionDigits={2} /></li>)}</ul> : <EmptyState title="No category activity">There are no published income or expense postings for this month.</EmptyState>}</section>
    </div>
    <p className="report-footnote">Pinned to one release for this request. Foreign currency, ownership-specific, card, investment and performance values remain unavailable until their evidenced modules are implemented.</p>
  </div>;
}
function AccountBalance({ currency, value, reason }: { currency: string; value: string | null; reason: string }) {
  if (currency === "INR") return <MoneyValue value={value} reason={reason} fractionDigits={2} />;
  return value === null ? <span className="money unknown" aria-label={`Unknown: ${reason}`} title={reason}>—<span className="sr-only"> {reason}</span></span>
    : <span className="money" title={`${currency} ${value}`}>{currency} {value}</span>;
}
function ReportMetric({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) {
  return <article className={`kpi-card report-metric tone-${tone}`}><h2 className="kpi-label">{label}</h2><p className="kpi-value"><MoneyValue value={value} /></p><p className="metric-note">{note}</p></article>;
}
