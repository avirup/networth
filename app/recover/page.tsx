import { AccessLayout } from "@/components/ui/primitives";
import { AccessForm } from "@/components/auth/access-form";
export default function RecoverPage() { return <AccessLayout title="Recover your account"><p>Use a saved recovery code or a private reset link from your household owner.</p><AccessForm mode="recover" /></AccessLayout>; }
