import { notFound } from "next/navigation";
import { localPreviewEnabled } from "@/lib/preview/access";
import { currentMonth, validMonth } from "@/lib/presentation/format";
import { navigation, type Section } from "@/lib/presentation/product";
import { PreviewWorkspace } from "@/components/preview/workspace";
import { previewStates, type PreviewState } from "@/lib/preview/states";
export const dynamic = "force-dynamic";
export default async function PreviewPage({ params, searchParams }: {
  params: Promise<{ section?: string[] }>; searchParams: Promise<{ month?: string; state?: string }>;
}) {
  if (!localPreviewEnabled()) notFound();
  const { section = [] } = await params;
  const active = section[0] ?? "overview";
  if (section.length > 1 || !navigation.some(item => item.id === active)) notFound();
  const query = await searchParams;
  const current = currentMonth();
  const period = typeof query.month === "string" && validMonth(query.month, current) ? query.month : current;
  const state = previewStates.includes(query.state as PreviewState) ? query.state as PreviewState : "ready";
  const { sampleSnapshot } = await import("@/lib/preview/fixtures");
  return <PreviewWorkspace active={active as Section} period={period} current={current} snapshot={period === sampleSnapshot.period ? sampleSnapshot : null} state={state} />;
}
