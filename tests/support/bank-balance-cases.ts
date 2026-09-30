import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { IdentityService } from "@/db/auth/service";
import { readBankBalanceInput } from "@/db/calculations/bank-balance-input";
import { confirmImport, reviewImport } from "@/db/imports/service";
import { encodedBytes, type Confirmation } from "@/lib/imports/review";

export function bankBalanceCases(admin: Pool, service: IdentityService, household: () => string, session: () => string) {
  let runId: string, accountId: string;
  let initial: Awaited<ReturnType<typeof readBankBalanceInput>>;
  const read = (input: unknown) => service.scoped(session(), household(), "read", (tx, actor) => readBankBalanceInput(tx, actor, input));
  it("evaluates captured bank evidence with a reviewed opening and exact closing balance", async () => {
    runId = (await admin.query("select id from ops.calculation_run where household_id=$1", [household()])).rows[0].id;
    accountId = (await admin.query("select id from core.dim_account where household_id=$1 and name='Synthetic reviewed opening bank'", [household()])).rows[0].id;
    initial = await read({ runId, accountId, asOf: "2026-09-30" });
    expect(initial.evidence.movements).toHaveLength(3);
    expect(initial.evidence.opening).toMatchObject({ kind: "reviewed_opening", balance: "100.000000000000", history: "unknown" });
    expect(initial.calculation).toMatchObject({ status: "reconciled", reconciledBalance: "115.000000000000", difference: "0.000000000000", history: "unknown", reasons: [] });
    expect(initial.evidence.coverage[0]!.completeness).toBe("complete");
    expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(3_000_000);
  });
  it("reads all 4,998 captured postings without promoting an observed opening to a ledger balance", async () => {
    const large = (await admin.query("select account_id from core.import_batch where household_id=$1 and row_count=5000", [household()])).rows[0].account_id;
    const result = await read({ runId, accountId: large, asOf: "2026-09-30" });
    expect(result.evidence.movements).toHaveLength(1);
    expect(result.evidence.movements[0]).toMatchObject({ postingCount: 4998, nativeDelta: "4998.000000000000" });
    expect(result.calculation).toMatchObject({ calculatedBalance: null, observedBalance: "4998.000000000000", reconciledBalance: null, reasons: ["missing_opening"] });
  });
  it("downgrades corrected statement coverage and counts unresolved provenance before netting", async () => {
    const corrected = (await admin.query(`select b.account_id from core.transaction_event e join core.import_batch b on b.id=e.batch_id
      where e.household_id=$1 and e.replaces_id is not null and e.kind='income' limit 1`, [household()])).rows[0].account_id;
    const result = await read({ runId, accountId: corrected, asOf: "2026-09-30" });
    // All salary statements link the subsequently reversed original; the replacement
    // upload is correction evidence. A separate transfer statement may remain valid.
    const correctedBatchIds = (await admin.query(`select distinct s.batch_id from core.source_record s join core.event_source_link l on l.source_id=s.id
      join core.transaction_event e on e.id=l.event_id where s.household_id=$1 and (e.replaces_id is not null or exists(select from core.transaction_event r where r.reverses_id=e.id))`, [household()])).rows.map(r => r.batch_id);
    const invalidated = result.evidence.coverage.filter(c => correctedBatchIds.includes(c.evidenceId));
    expect(invalidated.length).toBeGreaterThan(0);
    expect(invalidated.every(c => c.completeness === "partial")).toBe(true);
    const unresolved = (await admin.query(`select b.account_id from core.transaction_event e join core.import_batch b on b.id=e.batch_id
      where e.household_id=$1 and e.kind='unresolved_reconciliation' limit 1`, [household()])).rows[0].account_id;
    expect((await read({ runId, accountId: unresolved, asOf: "2026-09-30" })).evidence.unresolvedEventCount).toBe(1);
  });
  it("does not let a later backdated correction invalidate the captured balance evidence", async () => {
    await admin.query("update ops.import_admission set verified_until=now()+interval '1 hour',remaining_imports=100,remaining_storage_bytes=300000000");
    const eventId = (await admin.query(`select e.id from core.transaction_event e join core.import_batch b on b.id=e.batch_id where b.account_id=$1 and e.kind='income'`, [accountId])).rows[0].id;
    const input: Confirmation = {
      idempotencyKey: randomUUID(), expectedRevision: (await admin.query("select revision from ops.source_revision where household_id=$1", [household()])).rows[0].revision,
      manifest: { schemaVersion: "bank-v1", accountId, currency: "INR", coverageStart: "2026-09-01", coverageEnd: "2026-09-30", completeness: "complete", openingBalance: "100", closingBalance: "120", openingKnown: true, historyReason: "Unknown earlier history." },
      rows: [{ schema_version: "bank-v1", row_id: "corrected", transaction_ref: "synthetic-balance-correction", transaction_date: "2026-09-10", description: "Synthetic correction", direction: "credit", amount: "25", currency: "INR", event_type: "income", category: "salary", book_amount_inr: "", fx_rate: "", related_row_id: "" }],
      decisions: { corrected: { action: "replace", eventId, note: "Synthetic correction after the captured revision." } }, acknowledgements: [],
    };
    const result = await service.scoped(session(), household(), "import", async (tx, actor) => {
      input.acknowledgements = (await reviewImport(tx, actor, input)).warnings.map(w => w.code);
      return confirmImport(tx, actor, input, encodedBytes(input), true);
    });
    expect(result.revision).toBeGreaterThan(initial.calculation.sourceRevision);
    expect(await read({ runId, accountId, asOf: "2026-09-30" })).toEqual(initial);
  });
  it("enforces household/account/date boundaries and leaves observation-only accounts unknown", async () => {
    const other = (await admin.query("select id from ops.calculation_run where household_id<>$1", [household()])).rows[0].id;
    await expect(read({ runId: other, accountId, asOf: "2026-09-30" })).rejects.toMatchObject({ status: 404 });
    await expect(read({ runId, accountId: randomUUID(), asOf: "2026-09-30" })).rejects.toMatchObject({ status: 404 });
    await expect(read({ runId, accountId, asOf: "2026-02-30" })).rejects.toThrow();
    const future = await read({ runId, accountId, asOf: "2026-10-01" });
    expect(future.calculation.reasons).toEqual(["coverage_gap", "missing_closing"]);
    const empty = await read({ runId, accountId, asOf: "2026-08-31" });
    expect(empty.evidence.movements).toHaveLength(0);
    expect(empty.calculation.calculatedBalance).toBeNull();
    const observedOnly = (await admin.query("select id from core.dim_account where household_id=$1 and name='Synthetic planning account'", [household()])).rows[0].id;
    const observed = await read({ runId, accountId: observedOnly, asOf: "2026-07-01" });
    expect(observed.evidence.movements).toHaveLength(0);
    expect(observed.calculation).toMatchObject({ observedBalance: "0.000000000000", calculatedBalance: null, reconciledBalance: null, reasons: ["missing_opening"] });
  });
}
