export type Tone = "cobalt" | "violet" | "coral" | "amber" | "pink";
export type Stat = { label: string; value: string | null; change: string; tone: Tone; trend: { path: string; endY: number } | null };
export type Holding = { id: string; name: string; count: string; value: string | null; allocation: string; invested: string | null; movement: string; totalReturn: string; tone: Tone; details: Record<string, string> };
export type DashboardSnapshot = {
  period: string; asOf: string; release: string; stats: Stat[]; portfolioTotal: string; holdings: Holding[];
  cash: { name: string; value: string; width: number; tone: Tone }[];
  credit: { name: string; limit: string; used: string; percent: number; tone: Tone }[];
};
