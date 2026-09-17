import "server-only";
import type { DashboardSnapshot } from "@/components/dashboard/types";
/** Synthetic UI-only data. Never imported by database, financial domains or reporting APIs. */
export const sampleSnapshot: DashboardSnapshot = {
  period: "2026-09", asOf: "11 September 2026", release: "synthetic-september-v1",
  stats: [
    { label: "Net worth", value: "12450000", change: "+4.3%", tone: "cobalt", trend: { path: "M2 91 C30 88 40 67 69 70 C98 73 105 88 134 79 C163 70 170 43 201 49 C232 55 243 64 272 44 C301 24 324 36 358 17", endY: 17 } },
    { label: "Total income", value: "385000", change: "+8.6%", tone: "violet", trend: { path: "M2 83 C35 76 51 43 82 54 C113 65 124 84 155 68 C186 52 201 30 230 42 C259 54 274 67 300 43 C326 19 341 29 358 18", endY: 18 } },
    { label: "Total expenses", value: "142800", change: "+3.1%", tone: "coral", trend: { path: "M2 72 C31 69 45 36 77 40 C109 44 123 69 153 67 C183 65 199 34 227 43 C255 52 270 82 301 69 C332 56 342 46 358 50", endY: 50 } },
  ],
  portfolioTotal: "1501000",
  holdings: [
    { id: "shares", name: "Shares", count: "8 sample holdings", value: "525400", allocation: "35%", invested: "429000", movement: "+4.8%", totalReturn: "+22.5%", tone: "violet", details: { "Valuation date": "11 September 2026", "Valuation basis": "Illustrative closing price", "Cost basis": "Synthetic acquisition records", "Data source": "Sample fixture" } },
    { id: "deposits", name: "Fixed deposits", count: "3 sample deposits", value: "480000", allocation: "32%", invested: "452000", movement: "+0.6%", totalReturn: "+6.2%", tone: "cobalt", details: { "Valuation date": "11 September 2026", "Valuation basis": "Illustrative accrued value", "Next maturity": "18 June 2027", "Data source": "Sample fixture" } },
    { id: "funds", name: "Mutual funds", count: "6 sample schemes", value: "390600", allocation: "26%", invested: "348000", movement: "−1.2%", totalReturn: "+12.2%", tone: "amber", details: { "Valuation date": "11 September 2026", "Valuation basis": "Illustrative NAV", "Cost basis": "Synthetic acquisition records", "Data source": "Sample fixture" } },
    { id: "gold", name: "Sovereign gold bonds", count: "2 sample issues", value: "105000", allocation: "7%", invested: "100000", movement: "+0.3%", totalReturn: "+5.0%", tone: "coral", details: { "Valuation date": "11 September 2026", "Valuation basis": "Illustrative manual price", "Cost basis": "Synthetic acquisition records", "Data source": "Sample fixture" } },
  ],
  cash: [
    { name: "Everyday account", value: "245000", width: 81.67, tone: "cobalt" },
    { name: "Household savings", value: "180000", width: 60, tone: "violet" },
    { name: "Emergency reserve", value: "110000", width: 36.67, tone: "amber" },
    { name: "Joint account", value: "75000", width: 25, tone: "coral" },
    { name: "Travel account", value: "40000", width: 13.33, tone: "pink" },
  ],
  credit: [
    { name: "Everyday card", limit: "600000", used: "204000", percent: 34, tone: "cobalt" },
    { name: "Travel card", limit: "450000", used: "324000", percent: 72, tone: "amber" },
    { name: "Household card", limit: "300000", used: "174000", percent: 58, tone: "violet" },
    { name: "Shopping card", limit: "200000", used: "172000", percent: 86, tone: "pink" },
    { name: "Backup card", limit: "150000", used: "33000", percent: 22, tone: "cobalt" },
  ],
};
