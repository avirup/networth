"use client";
import Decimal from "decimal.js";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useReportPeriod } from "@/components/auth/period-context";
import { ChartFrame, DataQualityIndicator, Disclosure, EmptyState, ErrorState, LoadingState, MoneyValue } from "@/components/ui/primitives";
import { monthLabel } from "@/lib/presentation/format";
import type { BankActivityPage, BankOverview } from "@/db/reports/service";

type View = "overview" | "accounts" | "activity";
type Load = { period: string; report: BankOverview | null; error: boolean };

export function BankOverviewReport({ view = "overview" }: { view?: View }) {
  const period = useReportPeriod();
  const [state, setState] = useState<Load | null>(null);
  const reportCache = useRef(new Map<string, BankOverview>());
  useEffect(() => {
    const controller = new AbortController();
    const known = state?.report;
    const key = known ? [known.scope.id, known.scope.kind, known.release.id, known.release.asOf, period, "dashboard"].join(":") : null;
    const cached = key ? reportCache.current.get(key) : undefined;
    if (cached) { setState({ period, report: cached, error: false }); return () => controller.abort(); }
    const query = new URLSearchParams({ month: period });
    if (known?.release.id) query.set("release", known.release.id);
    fetch(`/api/reports/overview?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<BankOverview | null>; })
      .then(report => {
        if (report) reportCache.current.set([report.scope.id, report.scope.kind, report.release.id, report.release.asOf, period, "dashboard"].join(":"), report);
        setState({ period, report, error: false });
      }).catch(cause => { if (cause?.name !== "AbortError") setState({ period, report: null, error: true }); });
    return () => controller.abort();
    // The previously pinned release is intentionally reused across month changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);
  const current = state?.period === period ? state : null;
  if (!current) return <LoadingState />;
  if (current.error) return <ErrorState action={<button className="text-button" onClick={() => location.reload()}>Reload report</button>}>The published release could not be read. Reload the page; your last published data remains unchanged.</ErrorState>;
  const report = current.report;
  if (report === null) return <EmptyState title="No published report yet" action={<Link className="button" href="/dashboard/imports">Import a bank statement</Link>}>Confirm an import and let the calculation workflow publish its first complete banking release.</EmptyState>;
  return <div className="live-report" data-report-release={report.release.id}>
    <ReportQuality report={report} />
    {report.release.reloadedCurrent && <p className="release-notice" role="status">The earlier report expired, so every panel was reloaded from the current complete release.</p>}
    {view === "accounts" ? <AccountReport report={report} /> : view === "activity" ? <ActivityPanel report={report} period={period} /> : <Overview report={report} period={period} />}
    <p className="report-footnote">Household scope · release {report.release.id} · source revision {report.release.sourceRevision}. Foreign currency valuation, ownership-specific totals, cards, investments and performance remain unavailable until their evidenced modules are implemented.</p>
  </div>;
}

function ReportQuality({ report }: { report: BankOverview }) {
  const q = report.quality;
  const message = q.status === "paused" ? `Updates are paused${q.pauseReason ? ` (${q.pauseReason.replaceAll("_", " ")})` : ""}; this complete published release remains available.`
    : q.status === "stale" ? `Newer source revision ${q.latestSourceRevision} is still processing. All panels remain on revision ${report.release.sourceRevision}.`
    : q.status === "incomplete" ? `${report.summary.unknownAccountCount} account value${report.summary.unknownAccountCount === 1 ? " is" : "s are"} unavailable and ${q.incompleteBatchCount} import${q.incompleteBatchCount === 1 ? " has" : "s have"} partial coverage. Known totals exclude unknown values.`
    : `Published through ${report.release.asOf}; all panels use one complete release.`;
  return <DataQualityIndicator state={q.status}>{message}</DataQualityIndicator>;
}

function Overview({ report, period }: { report: BankOverview; period: string }) {
  return <>
    <section className="kpi-grid" aria-label="Published banking summary">
      <ReportMetric label="Known net worth" value={report.summary.netWorthInr} note="Reconciled INR bank and cash positions" tone="cobalt" />
      <ReportMetric label="Income this month" value={report.summary.monthlyIncomeInr} note="Recognized income; transfers excluded" tone="violet" />
      <ReportMetric label="Expenses this month" value={report.summary.monthlyExpenseInr} note="Recognized expenses; principal excluded" tone="coral" />
    </section>
    <div className="insight-grid">
      <CashFlowPanel report={report} period={period} />
      <LargestExpense value={report.largestExpense} period={period} />
    </div>
    <TrendPanel report={report} />
    <div className="published-grid"><AccountReport report={report} compact /><CategoryPanel report={report} period={period} /></div>
    <ActivityPanel report={report} period={period} compact />
  </>;
}

function CashFlowPanel({ report, period }: { report: BankOverview; period: string }) {
  const flow = report.cashFlow;
  const rows = [
    { label: "Recognized income", value: flow.recognizedIncomeInr, tone: "violet" },
    { label: "Recognized expenses", value: flow.recognizedExpenseInr, tone: "coral" },
    { label: "Debt principal", value: flow.debtPrincipalInr, tone: "pink" },
    { label: new Decimal(flow.otherFundingInr).isNegative() ? "Other outflow / cash drawdown" : "Other funding / cash release", value: flow.otherFundingInr, tone: "amber" },
    { label: "Net cash movement", value: flow.netCashMovementInr, tone: "cobalt" },
  ];
  const maximum = Decimal.max(...rows.map(row => new Decimal(row.value).abs()), new Decimal(1));
  return <ChartFrame title="Where this month’s money went" description={`${monthLabel(period)} · settled household cash boundary`} summary={<><MoneyValue value={flow.netCashMovementInr} /> net</>}>
    <div className="cash-flow-chart" role="img" aria-label={`Recognized income ${flow.recognizedIncomeInr} rupees, expenses ${flow.recognizedExpenseInr}, debt principal ${flow.debtPrincipalInr}, other funding ${flow.otherFundingInr}, net cash movement ${flow.netCashMovementInr}.`}>
      {rows.map(row => <div className="cash-flow-row" key={row.label}><div><span>{row.label}</span><MoneyValue value={row.value} fractionDigits={2} /></div><div className="cash-flow-track" aria-hidden="true"><span className={`tone-${row.tone}`} style={{ width: `${new Decimal(row.value).abs().div(maximum).mul(100).toNumber()}%` }} /></div></div>)}
    </div>
    <Disclosure title="How this cash flow is reconciled"><p>Net cash movement equals recognized income minus recognized expenses and debt principal, plus other funding. Internal transfers cancel when both accounts are inside the household boundary. Opening balances and unresolved reconciliation adjustments are excluded.</p><p>{flow.investmentReason}</p></Disclosure>
  </ChartFrame>;
}

function LargestExpense({ value, period }: { value: BankOverview["largestExpense"]; period: string }) {
  return <article className="expense-callout"><h2>Largest expense</h2>{value ? <p><strong><MoneyValue value={value.amountInr} /></strong> at <span>{value.counterparty}</span> on <time dateTime={value.date}>{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${value.date}T00:00:00Z`))}</time>.</p>
    : <p>No recognized expense event was published for {monthLabel(period)}.</p>}</article>;
}

function TrendPanel({ report }: { report: BankOverview }) {
  const maximum = Decimal.max(...report.trends.flatMap(row => [new Decimal(row.incomeInr), new Decimal(row.expenseInr)]), new Decimal(1));
  return <ChartFrame title="Income and expense trend" description="Twelve published months · snapshot balances are never summed">
    <div className="trend-chart" role="img" aria-label="Monthly recognized income and expense trend"><div className="trend-legend"><span><i className="tone-violet" />Income</span><span><i className="tone-coral" />Expense</span></div>
      <ol>{report.trends.map(row => <li key={row.month}><div className="trend-bars" aria-hidden="true"><span className="tone-violet" style={{ height: `${new Decimal(row.incomeInr).div(maximum).mul(100).toNumber()}%` }} /><span className="tone-coral" style={{ height: `${new Decimal(row.expenseInr).div(maximum).mul(100).toNumber()}%` }} /></div><time dateTime={row.month}>{row.month.slice(5, 7)}/{row.month.slice(2, 4)}</time><span className="sr-only">Income <MoneyValue value={row.incomeInr} />; expense <MoneyValue value={row.expenseInr} /></span></li>)}</ol></div>
    <Disclosure title="Read the monthly values"><dl className="text-values">{report.trends.map(row => <div key={row.month}><dt>{monthLabel(row.month.slice(0, 7))}</dt><dd>Income <MoneyValue value={row.incomeInr} /> · expense <MoneyValue value={row.expenseInr} /></dd></div>)}</dl></Disclosure>
  </ChartFrame>;
}

function AccountReport({ report, compact = false }: { report: BankOverview; compact?: boolean }) {
  const known = report.accounts.filter(row => row.currency === "INR" && row.reconciledBalance !== null);
  const total = known.reduce((sum, row) => sum.plus(row.reconciledBalance!), new Decimal(0));
  return <section className="chart-frame account-report"><header className="panel-header"><div><h2>{compact ? "Bank balances" : "Bank and cash accounts"}</h2><p>Point-in-time values as of {report.release.asOf}</p></div><strong><MoneyValue value={report.summary.knownAssetsInr} /></strong></header>
    {known.length > 0 && total.gt(0) && <div className="account-composition" aria-label="Known INR balance composition">{known.map((account, index) => <span key={account.id} className={`tone-${["cobalt", "violet", "coral", "amber", "pink"][index % 5]}`} style={{ width: `${new Decimal(account.reconciledBalance!).div(total).mul(100).toNumber()}%` }} title={`${account.name}: ${account.reconciledBalance}`} />)}</div>}
    <ul className="report-account-list">{report.accounts.map(account => <li key={account.id}><div><strong>{account.name}</strong><span>{account.currency} · {account.status} · {account.effectiveDate}</span></div><AccountBalance currency={account.currency} value={account.reconciledBalance} reason={account.reasons.join("; ") || "Balance is incomplete"} /></li>)}</ul>
  </section>;
}

function CategoryPanel({ report, period }: { report: BankOverview; period: string }) {
  return <section className="chart-frame"><header className="panel-header"><div><h2>Income and expenses</h2><p>{monthLabel(period)} · grouped recognized postings</p></div></header>
    {report.categories.length ? <ul className="report-category-list">{report.categories.map(row => <li key={`${row.kind}:${row.category}`}><div><strong>{row.category}</strong><span>{row.kind} · {row.postingCount} posting{row.postingCount === 1 ? "" : "s"}</span></div><MoneyValue value={row.amountInr} fractionDigits={2} /></li>)}</ul> : <EmptyState title="No category activity">There are no published income or expense postings for this month.</EmptyState>}
  </section>;
}

function ActivityPanel({ report, period, compact = false }: { report: BankOverview; period: string; compact?: boolean }) {
  const key = `${report.release.id}:${period}:${compact ? 10 : 25}`;
  const [state, setState] = useState<{ key: string; pages: BankActivityPage[]; error: boolean; loading: boolean } | null>(null);
  const current = state?.key === key ? state : { key, pages: [], error: false, loading: true };
  const next = current.pages.at(-1)?.nextCursor ?? null;
  const request = (cursor?: string | null) => {
    const query = new URLSearchParams({ month: period, release: report.release.id, limit: compact ? "10" : "25" });
    if (cursor) query.set("cursor", cursor);
    fetch(`/api/reports/activity?${query}`, { cache: "no-store" }).then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<BankActivityPage>; })
      .then(page => { if (page.reloadedCurrent && page.releaseId !== report.release.id) location.reload(); else setState(previous => ({ key, pages: cursor && previous?.key === key ? [...previous.pages, page] : [page], error: false, loading: false })); })
      .catch(() => setState(previous => ({ key, pages: previous?.key === key ? previous.pages : [], error: true, loading: false })));
  };
  useEffect(() => {
    const query = new URLSearchParams({ month: period, release: report.release.id, limit: compact ? "10" : "25" });
    fetch(`/api/reports/activity?${query}`, { cache: "no-store" }).then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<BankActivityPage>; })
      .then(page => { if (page.reloadedCurrent && page.releaseId !== report.release.id) location.reload(); else setState({ key, pages: [page], error: false, loading: false }); })
      .catch(() => setState({ key, pages: [], error: true, loading: false }));
  }, [compact, key, period, report.release.id]);
  const items = current.pages.flatMap(page => page.items);
  return <section className={`chart-frame activity-report ${compact ? "activity-compact" : ""}`}><header className="panel-header"><div><h2>Source activity</h2><p>{monthLabel(period)} · economic events with import provenance</p></div>{compact && <Link className="text-button" href="/dashboard/activity">Open activity</Link>}</header>
    {current.error ? <ErrorState action={<button className="text-button" onClick={() => request(next)}>Retry activity</button>}>The release is still available, but its activity page could not be loaded.</ErrorState>
      : current.loading && !items.length ? <LoadingState /> : !items.length ? <EmptyState title="No activity this month">No economic events from this release fall in the selected period.</EmptyState>
      : <ul className="activity-list">{items.map(item => <li key={item.id}><details><summary><span><strong>{item.description}</strong><small>{item.date} · {item.kind.replaceAll("_", " ")}{item.category ? ` · ${item.category}` : ""}</small></span><MoneyValue value={item.amountInr} fractionDigits={2} /></summary><dl><div><dt>Included account</dt><dd>{item.accounts ?? "Household boundary"}</dd></div><div><dt>Import revision</dt><dd>{item.import.revision}</dd></div><div><dt>Batch</dt><dd><code>{item.import.batchId}</code></dd></div>{item.sources.map(source => <div key={source.id}><dt>Source row {source.rowNumber}</dt><dd>{source.rowId ?? "Evidence row"}{source.transactionReference ? ` · ${source.transactionReference}` : ""}</dd></div>)}</dl></details></li>)}</ul>}
    {!current.error && next && <div className="activity-more"><button className="button secondary" disabled={current.loading} onClick={() => { setState({ ...current, loading: true }); request(next); }}>{current.loading ? "Loading…" : "Load more"}</button></div>}
  </section>;
}

function AccountBalance({ currency, value, reason }: { currency: string; value: string | null; reason: string }) {
  if (currency === "INR") return <MoneyValue value={value} reason={reason} fractionDigits={2} />;
  return value === null ? <span className="money unknown" aria-label={`Unknown: ${reason}`} title={reason}>—<span className="sr-only"> {reason}</span></span> : <span className="money" title={`${currency} ${value}`}>{currency} {value}</span>;
}
function ReportMetric({ label, value, note, tone }: { label: string; value: string; note: string; tone: string }) {
  return <article className={`kpi-card report-metric tone-${tone}`}><h2 className="kpi-label">{label}</h2><p className="kpi-value"><MoneyValue value={value} /></p><p className="metric-note">{note}</p></article>;
}
