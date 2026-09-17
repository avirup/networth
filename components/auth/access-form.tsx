"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn, signOut } from "next-auth/react";

export async function send(action: string, input: unknown) {
  const response = await fetch(`/api/identity/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Unable to continue. Please try again.");
  return result as { recoveryCodes?: string[]; token?: string };
}
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [saved, setSaved] = useState(false);
  return <div className="auth-form"><h2>Save your recovery codes</h2><p>These codes are shown once. Store them somewhere private. Each code can reset your password once and expires after one year.</p>
    <ul className="recovery-codes">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul>
    <button className="button secondary" onClick={() => { const blob = new Blob([codes.join("\n")], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "networth-recovery-codes.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download codes</button>
    <label className="check-label"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I have saved my recovery codes</label>
    {saved ? <Link className="button" href="/login">Continue to sign in</Link> : <button className="button" disabled>Continue to sign in</button>}
  </div>;
}
export function Field({ name, label, type = "text", autoComplete, minLength, maxLength = 254 }: { name: string; label: string; type?: string; autoComplete?: string; minLength?: number; maxLength?: number }) {
  return <label className="form-field">{label}<input required name={name} type={type} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength} /></label>;
}
export function AccessForm({ mode }: { mode: "setup" | "login" | "invite" | "recover" }) {
  const router = useRouter();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [codes, setCodes] = useState<string[]>(); const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      if (mode !== "login" && values.password !== values.confirmPassword) throw new Error("The passwords do not match.");
      delete values.confirmPassword;
      if (mode === "login") {
        const result = await signIn("credentials", { email: values.email, password: values.password, redirect: false });
        if (result?.error) throw new Error("Unable to sign in. Check your email and password, or use a recovery code.");
        router.replace("/dashboard"); router.refresh(); return;
      }
      if (mode === "invite") values.token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
      if (mode === "recover") {
        const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
        values.method = token ? "reset" : "code"; if (token) values.code = token;
      }
      const result = await send(mode === "invite" ? "invite-accept" : mode, values);
      form.reset(); window.history.replaceState(null, "", window.location.pathname);
      if (result.recoveryCodes) setCodes(result.recoveryCodes); else setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to continue."); } finally { setBusy(false); }
  }
  if (codes) return <RecoveryCodes codes={codes} />;
  if (done) return <div role="status"><p>Your password has been updated. Sign in with your new password.</p><Link className="button" href="/login">Sign in</Link></div>;
  return <form className="auth-form" onSubmit={submit} aria-busy={busy}>
    {mode === "setup" && <><p className="form-help">Use the setup code from your deployment’s BOOTSTRAP_SECRET setting.</p><Field name="setupCode" label="Setup code" type="password" autoComplete="off" maxLength={256} /></>}
    {(mode === "setup" || mode === "invite") && <Field name="name" label="Your name" autoComplete="name" maxLength={100} />}
    <Field name="email" label="Email" type="email" autoComplete="username" />
    {mode === "recover" && <label className="form-field">Recovery code <span className="form-help">Leave blank if you opened a private reset link.</span><input name="code" autoComplete="off" maxLength={100} /></label>}
    <Field name="password" label={mode === "recover" ? "New password" : "Password"} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={12} maxLength={1024} />
    {mode !== "login" && <><p className="form-help">Use at least 12 characters. A password manager or a long passphrase works well.</p><Field name="confirmPassword" label="Confirm password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} /></>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="button" disabled={busy}>{busy ? "Please wait…" : { setup: "Create owner account", login: "Sign in", invite: "Join household", recover: "Reset password" }[mode]}</button>
    <Link className="text-button" href={mode === "login" ? "/recover" : "/login"}>{mode === "login" ? "Recover your account" : "Back to sign in"}</Link>
  </form>;
}
export function Logout() { const [busy, setBusy] = useState(false); return <button className="button" disabled={busy} onClick={() => { setBusy(true); void signOut({ callbackUrl: "/login" }); }}>{busy ? "Signing out…" : "Sign out"}</button>; }
