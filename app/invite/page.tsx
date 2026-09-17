import { AccessLayout } from "@/components/ui/primitives";
import { AccessForm } from "@/components/auth/access-form";
export default function InvitePage() { return <AccessLayout title="Join your household"><p>Use the email on your invitation. If you already have an account, enter your existing password.</p><AccessForm mode="invite" /></AccessLayout>; }
