"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Field, RecoveryCodes, send } from "./access-form";
type Member = { userId: string; name: string; email: string; role: "owner" | "editor" | "viewer"; state: "active" | "disabled" };
type Invite = { id: string; email: string; role: string };
export function SecuritySettings({ members, invitations }: { members?: Member[]; invitations?: Invite[] }) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [codes, setCodes] = useState<string[]>(); const [link, setLink] = useState("");
  async function act(input: Record<string, unknown>, endpoint = "security") {
    setBusy(true); setError(""); setMessage(""); setLink("");
    try {
      const result = await send(endpoint, input);
      if (result.recoveryCodes) setCodes(result.recoveryCodes);
      if (result.token) setLink(`${window.location.origin}/${endpoint === "invite" ? "invite" : "recover"}#token=${result.token}`);
      setMessage(input.action === "confirm" ? "Password confirmed for five minutes." : "Saved.");
      if (input.action === "password" || input.action === "revokeSessions") { router.replace("/login"); router.refresh(); }
      else if (!result.recoveryCodes) router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save."); } finally { setBusy(false); }
  }
  async function form(event: FormEvent<HTMLFormElement>, action: string) {
    event.preventDefault(); const target = event.currentTarget; const values = Object.fromEntries(new FormData(target));
    await act(action === "invite" ? values : { ...values, action }, action === "invite" ? "invite" : "security"); target.reset();
  }
  if (codes) return <RecoveryCodes codes={codes} />;
  return <div className="security-sections" aria-busy={busy}>
    <div aria-live="polite">{message && <p role="status">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}{link && <><p>This private link is shown once. Copy it and share it directly with the intended person.</p><code className="private-link">{link}</code></>}</div>
    <section className="security-section"><h2>Confirm your password</h2><p>Confirm before changing security settings or household access.</p><form className="auth-form" onSubmit={event => form(event, "confirm")}><Field name="password" label="Current password" type="password" autoComplete="current-password" minLength={12} maxLength={1024} /><button className="button" disabled={busy}>Confirm password</button></form></section>
    <section className="security-section"><h2>Password and recovery</h2><form className="auth-form" onSubmit={event => form(event, "password")}><Field name="password" label="New password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} /><button className="button secondary" disabled={busy}>Change password</button></form><p>These actions sign you out on every device. New recovery codes replace all previous codes.</p><div className="access-actions"><button className="button secondary" disabled={busy} onClick={() => act({ action: "codes" })}>Replace recovery codes</button><button className="button secondary" disabled={busy} onClick={() => act({ action: "revokeSessions" })}>Sign out all devices</button></div></section>
    {members && <><section className="security-section"><h2>Invite a member</h2><p>Invitations expire after 24 hours. Reset links expire after 30 minutes.</p><form className="auth-form" onSubmit={event => form(event, "invite")}><Field name="email" label="Member email" type="email" autoComplete="off" /><label className="form-field">Role<select name="role"><option value="viewer">Viewer — read only</option><option value="editor">Editor — import and classify</option></select></label><button className="button" disabled={busy}>Create invitation</button></form>
      {invitations?.map(invite => <div className="member-row" key={invite.id}><span>{invite.email} · {invite.role}</span><button className="text-button" disabled={busy} onClick={() => act({ action: "revokeInvite", invitationId: invite.id })}>Revoke invitation</button></div>)}</section>
      <section className="security-section"><h2>Household members</h2><p>Access changes sign the affected person out. At least one active owner must remain.</p>{members.map(member => <form key={member.userId} className="member-row" onSubmit={event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void act({ ...values, action: "member", userId: member.userId }); }}><strong>{member.name}</strong><span>{member.email}</span><div className="member-controls"><label className="form-field">Role for {member.name}<select name="role" defaultValue={member.role}><option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label><label className="form-field">Access for {member.name}<select name="state" defaultValue={member.state}><option value="active">Active</option><option value="disabled">Disabled</option></select></label><button className="button secondary" disabled={busy}>Save access</button>{member.role !== "owner" && member.state === "active" && <button type="button" className="text-button" disabled={busy} onClick={() => act({ action: "reset", userId: member.userId })}>Create reset link</button>}</div></form>)}</section></>}
  </div>;
}
