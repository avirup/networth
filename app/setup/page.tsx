import Link from "next/link";
import { AccessLayout, DataQualityIndicator } from "@/components/ui/primitives";
export default function SetupPage() {
  return <AccessLayout title="Set up your private finance tracker"><p>Create the first owner account, then invite your household.</p><DataQualityIndicator state="paused">Owner setup is not available yet. No account can be created.</DataQualityIndicator><p>When setup becomes available, you’ll use your installation’s setup code. Public registration stays closed.</p><Link className="button secondary" href="/login">Back to sign in</Link></AccessLayout>;
}
