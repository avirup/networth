"use client";
import { useEffect, useState } from "react";
import { parseCardCsv, type CardRow } from "@/lib/imports/card-v1";
import { validateCardConfirmation, type CardConfirmation } from "@/lib/imports/card-review";
import { CATEGORY_DEFINITIONS } from "@/lib/finance/categories";
import type { Decision, Warning } from "@/lib/imports/review";

type Status = { accounts: { id: string; name: string; kind: string; currency: string }[]; facilities: { id: string; name: string; currency: string }[]; revision: number; ready: boolean; reason: string };
type Review = { revision: number; ready: boolean; reason: string; warnings: Warning[]; matches: { rowId: string; eventId: string; kind: string; effectiveDate: string; reason: string }[]; reconciliation: { status: string; difference: string | null; reason?: string | null } };
async function api<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/imports/${action}`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Request failed. Try again."); return result;
}
const fresh = (): CardConfirmation => ({
  idempotencyKey: crypto.randomUUID(), expectedRevision: 0,
  manifest: { schemaVersion: "card-v1", accountId: crypto.randomUUID(), currency: "INR", coverageStart: "", coverageEnd: "", completeness: "complete", openingOutstanding: null, statementOutstanding: null, historyReason: "Earlier card history is not available.", paymentDueDate: null, minimumDue: null },
  newAccount: { name: "", maskedReference: null }, facility: { id: crypto.randomUUID(), newFacility: { name: "" }, limitInr: null },
  rows: [], decisions: {}, acknowledgements: [], openingDecision: { action: "observe", note: "" },
});

export function CardImport({ canImport }: { canImport: boolean }) {
  const [status, setStatus] = useState<Status | null>(null), [data, setData] = useState<CardConfirmation>(fresh()), [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState(""), [result, setResult] = useState(""), [busy, setBusy] = useState(false), [fileName, setFileName] = useState(""), [fileVersion, setFileVersion] = useState(0);
  useEffect(() => { let active = true; api<Status>("status").then(value => { if (active) setStatus(value); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  function change(next: CardConfirmation) { setData({ ...next, idempotencyKey: crypto.randomUUID(), acknowledgements: [] }); setReview(null); setError(""); setResult(""); }
  function decide(row: CardRow, patch: Partial<Decision>) { change({ ...data, decisions: { ...data.decisions, [row.row_id]: { ...data.decisions[row.row_id]!, ...patch } } }); }
  async function load(file?: File) {
    if (!file) return; setBusy(true); setError("");
    try {
      if (file.size > 3_000_000) throw new Error("File exceeds 3,000,000 bytes.");
      const rows = parseCardCsv(await file.text()), dates = rows.map(row => row.transaction_date).sort();
      change({ ...data, rows, decisions: Object.fromEntries(rows.map(row => [row.row_id, { action: "new", note: "" }])), manifest: { ...data.manifest, coverageStart: dates[0] ?? data.manifest.coverageStart, coverageEnd: dates.at(-1) ?? data.manifest.coverageEnd } });
      setFileName(file.name);
    } catch (cause) { setFileVersion(value => value + 1); setError((cause as Error).message); } finally { setBusy(false); }
  }
  async function inspect() {
    setBusy(true); setError("");
    try { validateCardConfirmation(data); const next = await api<Review>("card-review", data); setData(value => ({ ...value, expectedRevision: next.revision, acknowledgements: [] })); setReview(next); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setError("");
    try {
      validateCardConfirmation(data); const saved = await api<{ batchId: string; revision: number; retry: boolean }>("card-confirm", data);
      setResult(`Card batch ${saved.batchId} saved at revision ${saved.revision}${saved.retry ? " (existing confirmation)" : ""}. Calculation is queued.`);
      setData(fresh()); setReview(null); setFileName(""); setFileVersion(value => value + 1); setStatus(await api<Status>("status"));
    } catch (cause) { setError(`${(cause as Error).message} Retry the unchanged confirmation if the connection failed.`); } finally { setBusy(false); }
  }
  const allAcknowledged = review?.warnings.every(warning => data.acknowledgements.includes(warning.code));
  return <div className="import-workspace">
    <section className="security-section import-intro"><h2>Import a credit-card statement</h2><p>Upload the standardized card CSV, review purchases and repayments, then confirm the complete batch. Nothing is saved before confirmation.</p>
      <div className="import-actions"><a className="text-button" href="/templates/card-v1.csv" download>Download card template</a><a className="text-button" href="/templates/card-v1-example.csv" download>Synthetic example</a><a className="text-button" href="/templates/card-v1-example-manifest.json" download>Manifest example</a></div>
      {status && !status.ready && <div className="quality quality-paused" role="status"><strong>Confirmation paused.</strong><span>{status.reason}</span></div>}{!canImport && <p>You have view access. Ask an owner or editor to confirm imports.</p>}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}{result && <p className="import-success" role="status">{result}</p>}
    {canImport && <><fieldset className="security-section import-fields" disabled={busy || !status}><legend>Statement, card and facility</legend>
      <label className="form-field">Card account<select value={data.newAccount ? "new" : data.manifest.accountId} onChange={event => { const account = status?.accounts.find(row => row.id === event.target.value); change({ ...data, newAccount: account ? undefined : { name: "", maskedReference: null }, manifest: { ...data.manifest, accountId: account?.id ?? crypto.randomUUID() } }); }}><option value="new">New credit card</option>{status?.accounts.filter(row => row.kind === "credit_card" && row.currency === "INR").map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      {data.newAccount && <><label className="form-field">Card name<input value={data.newAccount.name} maxLength={100} onChange={event => change({ ...data, newAccount: { ...data.newAccount!, name: event.target.value } })} /></label><label className="form-field">Masked reference<input placeholder="****1234" value={data.newAccount.maskedReference ?? ""} maxLength={8} onChange={event => change({ ...data, newAccount: { ...data.newAccount!, maskedReference: event.target.value || null } })} /></label></>}
      <label className="form-field">Credit facility<select value={data.facility.newFacility ? "new" : data.facility.id} onChange={event => { const facility = status?.facilities.find(row => row.id === event.target.value); change({ ...data, facility: facility ? { id: facility.id, limitInr: data.facility.limitInr } : { id: crypto.randomUUID(), newFacility: { name: "" }, limitInr: data.facility.limitInr } }); }}><option value="new">New facility</option>{status?.facilities.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      {data.facility.newFacility && <label className="form-field">Facility name<input value={data.facility.newFacility.name} maxLength={100} onChange={event => change({ ...data, facility: { ...data.facility, newFacility: { name: event.target.value } } })} /></label>}
      <label className="form-field">Credit limit (blank = unknown)<input inputMode="decimal" value={data.facility.limitInr ?? ""} onChange={event => change({ ...data, facility: { ...data.facility, limitInr: event.target.value || null } })} /></label>
      <label className="form-field import-wide">Card-v1 CSV<input key={fileVersion} type="file" aria-label="Card-v1 CSV" accept=".csv,text/csv" onChange={event => void load(event.target.files?.[0])} /><small>At most 4,998 transactions and 3,000,000 bytes.{fileName ? ` Loaded: ${fileName}.` : ""}</small></label>
      <label className="form-field">Coverage starts<input type="date" value={data.manifest.coverageStart} onChange={event => change({ ...data, manifest: { ...data.manifest, coverageStart: event.target.value } })} /></label>
      <label className="form-field">Statement date<input type="date" value={data.manifest.coverageEnd} onChange={event => change({ ...data, manifest: { ...data.manifest, coverageEnd: event.target.value } })} /></label>
      <label className="form-field">Coverage<select value={data.manifest.completeness} onChange={event => change({ ...data, manifest: { ...data.manifest, completeness: event.target.value as CardConfirmation["manifest"]["completeness"] } })}><option value="complete">Complete transactions</option><option value="partial">Partial transactions</option><option value="balance_only">Balance only</option></select></label>
      <label className="form-field">Opening outstanding<input inputMode="decimal" value={data.manifest.openingOutstanding ?? ""} onChange={event => change({ ...data, manifest: { ...data.manifest, openingOutstanding: event.target.value || null } })} /></label>
      <label className="form-field">Statement outstanding<input inputMode="decimal" value={data.manifest.statementOutstanding ?? ""} onChange={event => change({ ...data, manifest: { ...data.manifest, statementOutstanding: event.target.value || null } })} /></label>
      <label className="form-field">Payment due date<input type="date" value={data.manifest.paymentDueDate ?? ""} onChange={event => change({ ...data, manifest: { ...data.manifest, paymentDueDate: event.target.value || null } })} /></label>
      <label className="form-field">Minimum due<input inputMode="decimal" value={data.manifest.minimumDue ?? ""} onChange={event => change({ ...data, manifest: { ...data.manifest, minimumDue: event.target.value || null } })} /></label>
      <label className="form-field">Unknown-history reason<input value={data.manifest.historyReason} maxLength={500} onChange={event => change({ ...data, manifest: { ...data.manifest, historyReason: event.target.value } })} /></label>
      <label className="check-label import-wide"><input type="checkbox" checked={data.openingDecision.action === "establish"} onChange={event => change({ ...data, openingDecision: { action: event.target.checked ? "establish" : "observe", note: event.target.checked ? data.openingDecision.note : "" } })} />Establish the supplied opening debt in the ledger</label>
      {data.openingDecision.action === "establish" && <label className="form-field import-wide">Opening review note<input maxLength={500} value={data.openingDecision.note} onChange={event => change({ ...data, openingDecision: { ...data.openingDecision, note: event.target.value } })} /></label>}
    </fieldset>
    <section className="security-section card-review-panel"><h2>Review card activity</h2><p>{data.rows.length} transactions. Refunds reduce expenses; repayments move value between the bank and card without creating another expense.</p>
      {!!data.rows.length && <div className="import-table-scroll" tabIndex={0} role="region" aria-label="Card transaction review"><table className="import-table"><thead><tr><th>Transaction</th><th>Amount</th><th>Category</th><th>Decision</th></tr></thead><tbody>{data.rows.map(row => { const choice = data.decisions[row.row_id]!; return <tr key={row.row_id}><td><strong>{row.description}</strong><small>{row.transaction_date} · {row.event_type}</small></td><td className="import-amount">{row.direction === "debit" ? "+ debt " : "− debt "}{row.amount}</td><td><select aria-label={`Category for ${row.row_id}`} disabled={row.event_type === "card_repayment"} value={row.category} onChange={event => change({ ...data, rows: data.rows.map(item => item.row_id === row.row_id ? { ...item, category: event.target.value } : item) })}><option value="">Uncategorized</option>{CATEGORY_DEFINITIONS.filter(item => item[2] === "expense").map(item => <option key={item[0]} value={item[0]}>{item[1]}</option>)}</select></td><td><select aria-label={`Action for ${row.row_id}`} value={choice.action} onChange={event => decide(row, { action: event.target.value as Decision["action"], eventId: undefined })}><option value="new">New event</option><option value="link">Link existing</option><option value="replace">Reverse and replace</option></select>
          {choice.action !== "new" && <input aria-label={`Existing event for ${row.row_id}`} placeholder="Existing event ID" value={choice.eventId ?? ""} onChange={event => decide(row, { eventId: event.target.value || undefined })} />}
          {row.event_type === "card_repayment" && choice.action !== "link" && <select aria-label={`Bank account for ${row.row_id}`} value={choice.offsetAccountId ?? ""} onChange={event => decide(row, { offsetAccountId: event.target.value || undefined })}><option value="">Choose bank account</option>{status?.accounts.filter(account => ["bank", "cash"].includes(account.kind) && account.currency === "INR").map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>}
          <input aria-label={`Review note for ${row.row_id}`} placeholder="Review note" maxLength={500} value={choice.note} onChange={event => decide(row, { note: event.target.value })} /></td></tr>; })}</tbody></table></div>}
      <div className="import-actions"><button className="button" disabled={busy || !status} onClick={() => void inspect()}>{busy ? "Working…" : "Check card statement"}</button><button className="button secondary" disabled={busy} onClick={() => { setData(fresh()); setReview(null); setFileName(""); setFileVersion(value => value + 1); }}>Cancel preview</button></div>
    </section>
    {review && <section className="security-section"><h2>Confirm card statement</h2><p>Reconciliation: {review.reconciliation.status}{review.reconciliation.difference ? ` · difference ${review.reconciliation.difference} INR` : ""}. {review.reason}</p><div className="import-warnings">{review.warnings.map(warning => <label className="check-label" key={warning.code}><input type="checkbox" checked={data.acknowledgements.includes(warning.code)} onChange={event => setData({ ...data, acknowledgements: event.target.checked ? [...data.acknowledgements, warning.code] : data.acknowledgements.filter(code => code !== warning.code) })} />I acknowledge: {warning.message}</label>)}</div><button className="button" disabled={busy || !review.ready || !allAcknowledged} onClick={() => void confirm()}>Confirm and save card batch</button></section>}
    </>}
  </div>;
}
