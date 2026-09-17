import Link from "next/link";
import { AccessLayout } from "@/components/ui/primitives";
import { localPreviewEnabled } from "@/lib/preview/access";
export const dynamic = "force-dynamic";
export default function LoginPage() {
  return <AccessLayout title="Your financial picture, in one private place."><p>Sign-in is not available yet. Account setup is being prepared.</p>
    <div className="access-actions"><Link className="button secondary" href="/setup">View setup status</Link>{localPreviewEnabled() && <Link className="text-button" href="/preview">Explore the local design preview</Link>}</div>
  </AccessLayout>;
}
