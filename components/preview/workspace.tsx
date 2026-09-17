"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { ChartFrame, DataQualityIndicator, Disclosure, EmptyState, ErrorState, LoadingState, MoneyValue } from "@/components/ui/primitives";
import { StatCard } from "@/components/dashboard/stat-card";
import { Portfolio } from "@/components/dashboard/portfolio";
import { CashBalances, CreditUtilization } from "@/components/dashboard/balance-panels";
import { SampleMonthlyFlow, SampleNetWorthBridge } from "./sample-charts";
import type { DashboardSnapshot } from "@/components/dashboard/types";
import { navigation, type Section } from "@/lib/presentation/product";
import { monthLabel } from "@/lib/presentation/format";
import { previewStates, type PreviewState } from "@/lib/preview/states";
export function PreviewWorkspace({ active, period, current, snapshot, state }: { active: Section; period: string; current: string; snapshot: DashboardSnapshot | null; state: PreviewState }) {
  const router = useRouter();
  const href = (section: Section, month = period, nextState: PreviewState = state) => `/preview/${section}?month=${month}&state=${nextState}`;
  const selectPeriod = (value: string) => router.replace(href(active, value), { scroll: false });
  const missing = !snapshot || state === "empty";
  return <AppShell active={active} period={period} current={current} onPeriodChange={selectPeriod} href={href} identity={{ name: "Sample profile", initials: "SP", description: "No account is signed in.", actions: [{ label: "Profile and preferences", href: href("settings") }, { label: "Exit preview", href: "/login" }] }} notifications="There are no notifications in this preview.">
    <div className="preview-banner"><div><strong>Local design preview</strong><span>Synthetic examples only. No household data is loaded or saved.</span></div><label>Preview state<select value={state} onChange={event => router.replace(href(active, period, event.target.value as PreviewState), { scroll: false })}>{previewStates.map(value => <option key={value} value={value}>{value === "ready" ? "Example report" : value === "edge" ? "Long and unknown values" : value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label></div>
    {active !== "overview" ? <section className="feature-panel">
      {active === "imports" ? <><h2>Import your financial data</h2><p>Upload a standardized CSV, review every row, then confirm the import.</p><ol className="import-steps"><li>Choose a CSV</li><li>Review and resolve</li><li>Confirm import</li></ol><EmptyState title="Imports are not available yet">Account setup and the secure import workflow must be completed first. No files can be uploaded in this preview.</EmptyState><Disclosure title="What you’ll be able to import"><p>Standardized bank CSVs come first. Cards and investments follow in later releases. Original statements are prepared outside this app.</p></Disclosure></>
        : <EmptyState title={`${navigation.find(item => item.id === active)!.label} is coming later`}>This feature is not available yet. Use the overview to explore the sample dashboard.</EmptyState>}
      <Link className="button secondary" href={href("overview")}>Back to overview</Link></section>
      : state === "loading" ? <LoadingState /> : state === "error" ? <ErrorState action={<button className="button" onClick={() => router.replace(href(active, period, "ready"))}>Retry example</button>}>The example error state is active. Retry to return to the sample report.</ErrorState>
      : missing ? <EmptyState title={`No report for ${monthLabel(period)}`} action={<button className="button" onClick={() => router.replace(href(active, "2026-09", "ready"))}>View September 2026 example</button>}>This preview contains one September 2026 report. Other periods stay empty.</EmptyState>
      : <>
        <DataQualityIndicator state={state === "incomplete" || state === "edge" ? "incomplete" : state === "stale" ? "stale" : state === "paused" ? "paused" : "complete"}>
          {state === "paused" ? "The example capacity limit is reached. The last report remains available; new work is deferred." : state === "stale" ? "Newer values are unavailable. All panels still show the same September example." : state === "incomplete" || state === "edge" ? "A valuation is missing. The net-worth total is unknown; known values remain visible." : `As of ${snapshot.asOf} · One consistent sample report`}
        </DataQualityIndicator>
        <div className="dashboard-layout" data-report-release={snapshot.release}><div className="dashboard-primary"><section className="kpi-grid" aria-label="Key financial indicators">{snapshot.stats.map((stat, index) => <StatCard key={stat.label} stat={{ ...stat, ...((state === "incomplete" || state === "edge") && index === 0 ? { value: null, change: "Unavailable", trend: null } : {}), ...(state === "edge" && index === 1 ? { value: "12345678901234567890123456.123456789012" } : {}), ...(state === "edge" && index === 2 ? { value: "-142800.500000000001" } : {}) }} />)}</section>
          <div className="insight-grid"><ChartFrame title="Where this month’s money went" description="September 2026 · illustrative cash movement" summary={<><MoneyValue value="385000" /> received</>}><SampleMonthlyFlow /><Disclosure title="Read the cash-flow values"><dl className="text-values"><div><dt>Salary</dt><dd>₹3,10,000</dd></div><div><dt>Freelance</dt><dd>₹55,000</dd></div><div><dt>Other income</dt><dd>₹20,000</dd></div><div><dt>Essential expenses</dt><dd>₹1,02,000</dd></div><div><dt>Lifestyle expenses</dt><dd>₹40,800</dd></div><div><dt>Investments</dt><dd>₹1,20,000</dd></div><div><dt>Debt repayment</dt><dd>₹35,000</dd></div><div><dt>Free cash</dt><dd>₹87,200</dd></div></dl><p>Investment principal and debt repayments are shown separately from expenses.</p></Disclosure></ChartFrame>
          <article className="expense-callout"><h2>Largest expense</h2><p>A sample transaction of <strong><MoneyValue value="10000" /></strong> at <span>Example Store</span> on <time dateTime="2026-09-10">10 September</time>.</p></article></div>
          <Portfolio holdings={state === "edge" ? snapshot.holdings.map((row, index) => index === 0 ? { ...row, name: "Long household investment account name with an unavailable valuation", value: null, invested: null, movement: "Unknown", totalReturn: "Unknown", allocation: "Unknown" } : row) : snapshot.holdings} total={state === "edge" ? null : snapshot.portfolioTotal} asOf={snapshot.asOf} />
        </div><aside className="dashboard-rail" aria-label="Balances and liabilities">
          <ChartFrame title="How net worth is built" description={`Illustrative closing values · ${snapshot.asOf}`}>{state === "incomplete" || state === "edge" ? <EmptyState title="Net worth is incomplete">A missing valuation prevents a reliable total.</EmptyState> : <><SampleNetWorthBridge /><Disclosure title="Read the net-worth values"><p>Cash ₹6,50,000 + investments ₹15,01,000 + property ₹1,11,99,000 − liabilities ₹9,00,000 = net worth ₹1,24,50,000. Chart labels are abbreviated.</p></Disclosure></>}</ChartFrame>
          <CreditUtilization rows={snapshot.credit} /><CashBalances rows={snapshot.cash} />
        </aside></div>
      </>}
  </AppShell>;
}
