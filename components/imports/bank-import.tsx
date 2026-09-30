"use client";
import { useEffect, useState } from "react";
import { parseBankCsv } from "@/lib/imports/csv";
import { categoryKind, encodedBytes, validateConfirmation, type Confirmation, type Decision, type Warning } from "@/lib/imports/review";
import { CATEGORY_DEFINITIONS } from "@/lib/finance/categories";
import type { BankRow } from "@/lib/imports/bank-v1";

type Status = { accounts: { id: string; name: string; kind: string; currency: string }[]; revision: number; ready: boolean; reason: string; history: { id: string; revision: number; accountName: string; rowCount: number; state: string; calculationState?: string; planningExecutionState?: string; reportState?: string }[] };
type Review = { revision: number; ready: boolean; reason: string; warnings: Warning[]; matches: { rowId: string; eventId: string; kind: string; effectiveDate: string; reason: string }[]; reconciliation: { status: string; difference: string | null } };
async function api<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/imports/${action}`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed. Try again.");
  return result;
}
const fresh = (): Confirmation => ({ idempotencyKey: crypto.randomUUID(), expectedRevision: 0, manifest: { schemaVersion: "bank-v1", accountId: crypto.randomUUID(), currency: "INR", coverageStart: "", coverageEnd: "", completeness: "complete", openingBalance: null, closingBalance: null, openingKnown: false, historyReason: "Earlier history is not available." }, newAccount: { name: "", maskedReference: null }, rows: [], decisions: {}, acknowledgements: [] });
export function BankImport({ canImport }: { canImport: boolean }) {
  const [status, setStatus] = useState<Status | null>(null), [data, setData] = useState<Confirmation | null>(null), [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState(""), [fileName, setFileName] = useState("");
  const [fileVersion, setFileVersion] = useState(0);
  const [page, setPage] = useState(0), [selected, setSelected] = useState<string[]>([]), [bulk, setBulk] = useState("");
  const [records, setRecords] = useState<{ id: string; effectiveDate: string; kind: string; amount: string; category: string | null }[]>([]), [recordPage, setRecordPage] = useState(0);
  const [observations, setObservations] = useState<{ id: string; asOf: string; balance: string | null; status: string; difference: string | null; explanation: string | null }[]>([]);
  useEffect(() => { let active = true; api<Status>("status").then(value => { if (active) { setData(fresh()); setStatus(value); } }).catch(e => { if (active) { setData(fresh()); setError(e.message); } }); return () => { active = false; }; }, []);
  function change(next: Confirmation) { setData({ ...next, idempotencyKey: crypto.randomUUID(), acknowledgements: [] }); setReview(null); setError(""); setResult(""); }
  function decision(row: BankRow, patch: Partial<Decision>) { if (data) change({ ...data, decisions: { ...data.decisions, [row.row_id]: { ...data.decisions[row.row_id]!, ...patch } } }); }
  async function refresh() { setBusy(true); setError(""); try { setStatus(await api<Status>("status")); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function load(file?: File) {
    if (!file || !data) return;
    setBusy(true); setError(""); setReview(null);
    try {
      if (file.size > 3_000_000) throw new Error("File exceeds 3,000,000 bytes. Split it into separately reviewed batches.");
      const rows = parseBankCsv(await file.text()), dates = rows.map(row => row.transaction_date).sort();
      change({ ...data, rows, decisions: Object.fromEntries(rows.map(row => [row.row_id, { action: "new", note: "" }])), manifest: { ...data.manifest, coverageStart: dates[0] ?? data.manifest.coverageStart, coverageEnd: dates.at(-1) ?? data.manifest.coverageEnd, currency: data.newAccount ? rows[0]?.currency ?? data.manifest.currency : data.manifest.currency } });
      setPage(0); setSelected([]); setFileName(file.name);
    } catch (e) { setFileVersion(v => v + 1); setError(`${(e as Error).message}${fileName ? ` The preview still contains ${fileName}; the replacement was not loaded.` : " No CSV was loaded."}`); } finally { setBusy(false); }
  }
  async function inspect() {
    if (!data) return; setBusy(true); setError("");
    try { validateConfirmation(data); const next = await api<Review>("review", data); setData({ ...data, expectedRevision: next.revision, acknowledgements: [] }); setReview(next); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!data || !review) return; setBusy(true); setError("");
    try {
      validateConfirmation(data);
      const saved = await api<{ batchId: string; revision: number; retry: boolean }>("confirm", data);
      setResult(`Batch ${saved.batchId} saved at revision ${saved.revision}${saved.retry ? " (existing confirmation)" : ""}. Calculation is queued; no report has been published yet.`);
      setData(fresh()); setReview(null); setFileName(""); setFileVersion(v => v + 1); setSelected([]); setPage(0); setStatus(await api<Status>("status"));
    } catch (e) { setError(`${(e as Error).message} If the connection failed, retry this unchanged confirmation to check whether it was saved.`); } finally { setBusy(false); }
  }
  async function loadRecords(nextPage: number) {
    if (!data || data.newAccount) return; setBusy(true); setError("");
    try { const [events, balances] = await Promise.all([api<typeof records>(`records?account=${data.manifest.accountId}&page=${nextPage}`), api<typeof observations>(`observations?account=${data.manifest.accountId}&page=${nextPage}`)]); setRecords(events); setObservations(balances); setRecordPage(nextPage); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!data) return <p role="status">Loading import workspace…</p>;
  const allAcknowledged = review?.warnings.every(w => data.acknowledgements.includes(w.code));
  return <div className="import-workspace">
    <section className="security-section import-intro"><h2>Import a bank statement</h2><p>Choose a standardized CSV, classify your transactions, then review and confirm. Your file stays in this browser until you request a review. Nothing is saved before confirmation.</p>
      <div className="import-actions"><a className="text-button" href="/templates/bank-v1.csv" download>Download CSV template</a><a className="text-button" href="/templates/bank-v1-example.csv" download>Synthetic example</a><a className="text-button" href="/templates/categories-v1.csv" download>Category codes</a></div>
      {status && (status.ready ? <p role="status">{status.reason}</p> : <div className="quality quality-paused" role="status"><strong>Confirmation paused.</strong><span>Ask your installation owner to verify the calculation service and available capacity, then recheck readiness.</span><button className="text-button" disabled={busy} onClick={() => void refresh()}>Recheck import readiness</button></div>)}{!canImport && <p>You have view access. Ask an owner or editor to review and confirm imports.</p>}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}{result && <p className="import-success" role="status">{result}</p>}
    {canImport && <><fieldset className="security-section import-fields" disabled={busy || !status}><legend>1. Statement and account</legend>
      <label className="form-field">Statement account<select value={data.newAccount ? "new" : data.manifest.accountId} onChange={e => { const account = status?.accounts.find(a => a.id === e.target.value); setRecords([]); setObservations([]); change({ ...data, newAccount: account ? undefined : { name: "", maskedReference: null }, manifest: { ...data.manifest, accountId: account?.id ?? crypto.randomUUID(), currency: account?.currency ?? "INR" } }); }}><option value="new">New bank account — saved on confirmation</option>{status?.accounts.filter(a => ["bank", "cash"].includes(a.kind)).map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</select></label>
      {data.newAccount && <><label className="form-field">New account name<input value={data.newAccount.name} maxLength={100} onChange={e => change({ ...data, newAccount: { ...data.newAccount!, name: e.target.value } })} /></label><label className="form-field">Masked reference (optional)<input placeholder="****1234" value={data.newAccount.maskedReference ?? ""} maxLength={8} onChange={e => change({ ...data, newAccount: { ...data.newAccount!, maskedReference: e.target.value || null } })} /></label></>}
      <label className="form-field">Currency<select disabled={!data.newAccount} value={data.manifest.currency} onChange={e => change({ ...data, manifest: { ...data.manifest, currency: e.target.value } })}>{["INR", "USD", "EUR", "GBP", "JPY"].map(c => <option key={c}>{c}</option>)}</select></label>
      <label className="form-field import-wide">Bank-v1 CSV<input key={fileVersion} type="file" aria-label="Bank-v1 CSV" aria-describedby="csv-limit" accept=".csv,text/csv" onChange={e => void load(e.target.files?.[0])} /><small id="csv-limit">At most 4,998 transactions plus two balance observations, and 3,000,000 bytes for the full confirmation.</small>{fileName && <small>Preview file: {fileName}</small>}</label>
      <label className="form-field">Coverage starts<input type="date" value={data.manifest.coverageStart} onChange={e => change({ ...data, manifest: { ...data.manifest, coverageStart: e.target.value } })} /></label>
      <label className="form-field">Coverage ends<input type="date" value={data.manifest.coverageEnd} onChange={e => change({ ...data, manifest: { ...data.manifest, coverageEnd: e.target.value } })} /></label>
      <label className="form-field">Statement completeness<select value={data.manifest.completeness} onChange={e => change({ ...data, manifest: { ...data.manifest, completeness: e.target.value as Confirmation["manifest"]["completeness"] } })}><option value="complete">Complete transaction coverage</option><option value="partial">Partial transaction coverage</option><option value="balance_only">Balance evidence only</option></select></label>
      <label className="form-field">Opening balance (blank = unknown)<input inputMode="decimal" value={data.manifest.openingBalance ?? ""} onChange={e => change({ ...data, manifest: { ...data.manifest, openingBalance: e.target.value || null, openingKnown: !!e.target.value } })} /></label>
      <label className="form-field">Closing balance (blank = unknown)<input inputMode="decimal" value={data.manifest.closingBalance ?? ""} onChange={e => change({ ...data, manifest: { ...data.manifest, closingBalance: e.target.value || null } })} /></label>
      <label className="form-field">Reason for unknown history<input value={data.manifest.historyReason} maxLength={500} onChange={e => change({ ...data, manifest: { ...data.manifest, historyReason: e.target.value } })} /></label>
      <p className="import-wide">Balances are reconciliation evidence. They never create assets automatically. Opening ledger balances require explicit opening_balance rows and a review note.</p>
    </fieldset>
    <section className="security-section import-review-panel"><h2>2. Classify and review</h2><p>{data.rows.length} transactions{fileName ? ` · ${fileName}` : " · Choose a CSV above, or use balance-only evidence."} · {encodedBytes(data).toLocaleString("en-IN")} confirmation bytes</p>
      {!!data.rows.length && <><div className="import-actions"><label className="form-field">Bulk category<select value={bulk} onChange={e => setBulk(e.target.value)}><option value="">Uncategorized</option>{CATEGORY_DEFINITIONS.map(c => <option key={c[0]} value={c[0]}>{c[1]} ({c[2]})</option>)}</select></label><button className="button secondary" disabled={busy || !selected.length} onClick={() => {
        const category = CATEGORY_DEFINITIONS.find(c => c[0] === bulk);
        if (data.rows.some(row => selected.includes(row.row_id) && (!categoryKind(row) || (category && categoryKind(row) !== category[2])))) { setError("Select only income or expense rows matching the chosen category."); return; }
        change({ ...data, rows: data.rows.map(row => selected.includes(row.row_id) ? { ...row, category: bulk } : row) });
      }}>Apply to {selected.length} selected</button></div>
      <div className="import-table-scroll" tabIndex={0} role="region" aria-label="Transaction review"><table className="import-table"><thead><tr><th>Select</th><th>Transaction</th><th>Amount</th><th>Category</th><th>Review decision</th></tr></thead><tbody>{data.rows.slice(page * 50, page * 50 + 50).map(row => {
        const choice = data.decisions[row.row_id]!, kind = categoryKind(row), candidates = review?.matches.filter(m => m.rowId === row.row_id) ?? [];
        return <tr key={row.row_id}><td><input type="checkbox" aria-label={`Select row ${row.row_id}`} checked={selected.includes(row.row_id)} onChange={e => setSelected(e.target.checked ? [...selected, row.row_id] : selected.filter(id => id !== row.row_id))} /></td><td><strong>{row.description}</strong><small>{row.transaction_date} · {row.event_type} · Row {row.row_id}</small></td><td className="import-amount"><span className="import-mobile-label">Amount</span>{row.direction === "debit" ? "−" : "+"}{row.amount} {row.currency}</td><td><label className="form-field"><span className="import-mobile-label" aria-hidden="true">Category</span><span className="sr-only">Category for row {row.row_id}</span><select disabled={busy || !kind} value={row.category} onChange={e => change({ ...data, rows: data.rows.map(r => r.row_id === row.row_id ? { ...r, category: e.target.value } : r) })}><option value="">{kind ? "Uncategorized" : "Not income / expense"}</option>{CATEGORY_DEFINITIONS.filter(c => c[2] === kind).map(c => <option key={c[0]} value={c[0]}>{c[1]}</option>)}</select></label></td><td><fieldset className="import-row-decision" disabled={busy}><legend className="sr-only">Decision for row {row.row_id}</legend><label className="form-field">Action<select aria-label={`Action for row ${row.row_id}`} value={choice.action} onChange={e => decision(row, { action: e.target.value as Decision["action"], eventId: undefined })}><option value="new">Save as a separate event</option><option value="link">Link existing event</option><option value="replace">Reverse and replace event</option></select></label>
          {candidates.length > 0 && <p>Possible matches: {candidates.map(c => <span key={c.eventId}>{c.effectiveDate} · {c.kind}<br /><code>{c.eventId}</code><br /></span>)}</p>}
          {choice.action !== "new" && <label className="form-field">Existing event ID<input value={choice.eventId ?? ""} onChange={e => decision(row, { eventId: e.target.value || undefined })} /></label>}
          {choice.action !== "link" && ["transfer", "card_repayment"].includes(row.event_type) && <label className="form-field">Other account<select value={choice.offsetAccountId ?? ""} onChange={e => decision(row, { offsetAccountId: e.target.value || undefined })}><option value="">Choose the other account</option>{status?.accounts.filter(a => a.id !== data.manifest.accountId && a.currency === "INR" && (row.event_type === "card_repayment" ? a.kind === "credit_card" : ["bank", "cash"].includes(a.kind))).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
          <label className="form-field">Review note<input maxLength={500} value={choice.note} onChange={e => decision(row, { note: e.target.value })} /></label>
          {row.event_type === "unresolved_reconciliation" && <label className="form-field">Closing observation to resolve (optional ID)<input value={choice.resolutionObservationId ?? ""} onChange={e => decision(row, { resolutionObservationId: e.target.value || undefined })} /></label>}
        </fieldset></td></tr>;
      })}</tbody></table></div><div className="import-actions"><button className="button secondary" disabled={!page} onClick={() => setPage(page - 1)}>Previous rows</button><span>Page {page + 1} of {Math.ceil(data.rows.length / 50)}</span><button className="button secondary" disabled={(page + 1) * 50 >= data.rows.length} onClick={() => setPage(page + 1)}>Next rows</button></div></>}
      <div className="import-actions"><button className="button" disabled={busy || !status} onClick={() => void inspect()}>{busy ? "Working…" : "Check statement for review"}</button><button className="button secondary" disabled={busy} onClick={() => { change(fresh()); setFileName(""); setFileVersion(v => v + 1); setPage(0); setSelected([]); setRecords([]); setObservations([]); }}>Cancel preview</button></div>
    </section>
    {review && <section className="security-section"><h2>3. Confirm reviewed statement</h2><p>Reconciliation: {review.reconciliation.status}{review.reconciliation.difference ? ` · difference ${review.reconciliation.difference} ${data.manifest.currency}` : ""}. {review.reason}</p>
      <div className="import-warnings">{review.warnings.map(w => <label className="check-label" key={w.code}><input type="checkbox" disabled={busy} checked={data.acknowledgements.includes(w.code)} onChange={e => setData({ ...data, acknowledgements: e.target.checked ? [...data.acknowledgements, w.code] : data.acknowledgements.filter(code => code !== w.code) })} />I acknowledge: {w.message}</label>)}</div>
      <p>Confirming saves this entire batch, including {data.rows.length + 2} evidence rows. Corrections remain traceable. Changing any field requires a new review.</p><button className="button" disabled={busy || !review.ready || !allAcknowledged} onClick={() => void confirm()}>Confirm and save batch</button>
    </section>}
    {!data.newAccount && <section className="security-section"><h2>Existing events for this account</h2><p>Use an event ID to link matching evidence or reverse and replace a mistake.</p><button className="button secondary" disabled={busy} onClick={() => void loadRecords(0)}>Load existing events</button>{!!observations.length && <details><summary>Closing balance observations and reconciliation</summary><ul className="import-records">{observations.map(o => <li key={o.id}>{o.asOf} · Balance {o.balance ?? "unknown"} · {o.status} · Difference {o.difference ?? "unknown"}<br /><code>{o.id}</code>{o.explanation && <p>{o.explanation}</p>}</li>)}</ul></details>}<ul className="import-records">{records.map(r => <li key={r.id}>{r.effectiveDate} · {r.kind} · {r.amount} {data.manifest.currency} · {r.category ?? "Uncategorized"}<br /><code>{r.id}</code></li>)}</ul>{!!records.length && <div className="import-actions"><button className="button secondary" disabled={busy || !recordPage} onClick={() => void loadRecords(recordPage - 1)}>Previous events</button><button className="button secondary" disabled={busy || records.length < 100} onClick={() => void loadRecords(recordPage + 1)}>Next events</button></div>}</section>}
    </>}
    <section className="security-section"><h2>Import history</h2><p>Latest 100 batches. “Queued” means saved and awaiting calculation. Reports are published by the calculation workflow.</p><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh status</button>{!status?.history.length ? <p>No confirmed batches yet.</p> : <ul className="import-records">{status.history.map(b => <li key={b.id}><strong>{b.accountName}</strong> · Revision {b.revision} · {b.rowCount} evidence rows · {b.reportState ? "Report published" : b.calculationState === "superseded" ? "Superseded by newer evidence" : b.planningExecutionState === "paused" ? "Calculation paused" : b.state === "pending" ? "Queued" : "Calculating"}<br /><code>{b.id}</code></li>)}</ul>}</section>
  </div>;
}
