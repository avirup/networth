import Link from "next/link";
import { AccessLayout, DataQualityIndicator } from "@/components/ui/primitives";
export default function StatusPage() {
  return <AccessLayout title="Your installation is being prepared"><DataQualityIndicator state="paused">Sign-in, imports and financial reports are not available yet.</DataQualityIndicator><p>Detailed connection and storage status will be available to the owner after sign-in.</p><Link className="button secondary" href="/login">Back to sign in</Link></AccessLayout>;
}
