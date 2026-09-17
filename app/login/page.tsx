import Link from "next/link";
import { AccessLayout } from "@/components/ui/primitives";
import { AccessForm } from "@/components/auth/access-form";
import { localPreviewEnabled } from "@/lib/preview/access";
export const dynamic = "force-dynamic";
export default function LoginPage() {
  return <AccessLayout title="Sign in"><p>Your financial picture, in one private place.</p><AccessForm mode="login" />{localPreviewEnabled() && <div className="access-actions"><Link className="text-button" href="/preview">Explore the local design preview</Link></div>}</AccessLayout>;
}
