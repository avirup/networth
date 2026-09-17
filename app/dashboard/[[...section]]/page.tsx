import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActor, identity } from "@/lib/auth/runtime";
import { Workspace } from "@/components/auth/workspace";
import { SecuritySettings } from "@/components/auth/security-settings";
import { EmptyState } from "@/components/ui/primitives";
import { navigation, type Section } from "@/lib/presentation/product";
export const dynamic = "force-dynamic";
export default async function DashboardPage({ params }: { params: Promise<{ section?: string[] }> }) {
  const { actor, reference } = await requireActor();
  const parts = (await params).section;
  const section = (parts?.[0] ?? "overview") as Section;
  if ((parts?.length ?? 0) > 1 || !navigation.some(item => item.id === section)) notFound();
  const members = section === "settings" && actor.role === "owner" ? await identity().members(reference) : undefined;
  const current = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date());
  return <Workspace name={actor.name} role={actor.role} section={section} current={current}>
    {section === "settings" ? <><SecuritySettings members={members?.members} invitations={members?.invitations} />{actor.role === "owner" && <div className="access-actions"><Link href="/status" className="text-button">Installation status</Link></div>}</>
      : <EmptyState title={section === "overview" ? "Your household is ready" : "This workspace is being prepared"} >Account access is ready. Financial imports and reports will become available in the next implementation phases; no financial records have been created.</EmptyState>}
  </Workspace>;
}
