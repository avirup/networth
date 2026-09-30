import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { createIdentityService } from "@/db/auth/service";
import { confirmImport, reviewImport } from "@/db/imports/service";
import { encodedBytes, type Confirmation } from "@/lib/imports/review";
export function importCases(admin: Pool, service: ReturnType<typeof createIdentityService>, household: () => string) {
  let reference: string, saved: Confirmation, batchId: string;
  const scoped = <T>(work: Parameters<typeof service.scoped<T>>[3]) => service.scoped(reference, household(), "import", work);
  const confirm = (input: Confirmation) => scoped((tx, actor) => confirmImport(tx, actor, input, encodedBytes(input), true));
  const ready = () => admin.query("insert into ops.import_admission(singleton,verified_until,workflow_verified,remaining_imports,remaining_storage_bytes,reason) values(true,now()+interval '1 hour',true,100,300000000,'Synthetic verified fixture') on conflict(singleton) do update set verified_until=excluded.verified_until,workflow_verified=true,remaining_imports=100,remaining_storage_bytes=300000000");
  const base = async (): Promise<Confirmation> => ({ idempotencyKey: randomUUID(), expectedRevision: (await admin.query("select revision from ops.source_revision where household_id=$1", [household()])).rows[0].revision, newAccount: { name: "Synthetic import account", maskedReference: "****1234" }, manifest: { schemaVersion: "bank-v1", accountId: randomUUID(), currency: "INR", coverageStart: "2026-09-01", coverageEnd: "2026-09-30", completeness: "complete", openingBalance: "0", closingBalance: "100", openingKnown: true, historyReason: "" }, rows: [{ schema_version: "bank-v1", row_id: "salary", transaction_ref: "synthetic-salary", transaction_date: "2026-09-10", description: "Synthetic salary", direction: "credit", amount: "100", currency: "INR", event_type: "income", category: "salary", book_amount_inr: "", fx_rate: "", related_row_id: "" }], decisions: { salary: { action: "new", note: "" } }, acknowledgements: [] });
  it("reviews without persistence and fails closed without verified workflow capacity", async () => {
    reference = (await service.login("owner@example.test", "local recovered synthetic password", "import-tests"))!.reference;
    saved = await base();
    const review = await scoped((tx, actor) => reviewImport(tx, actor, saved));
    expect(review.ready).toBe(false); expect(review.reconciliation.status).toBe("matched");
    await expect(confirm(saved)).rejects.toThrow();
    expect((await admin.query("select count(*)::int n from core.dim_account where id=$1", [saved.manifest.accountId])).rows[0].n).toBe(0);
  });
  it("commits evidence, ledger, revision, outbox and reservations atomically; retries once", async () => {
    await ready(); const result = await confirm(saved); batchId = result.batchId;
    expect((await confirm(saved)).retry).toBe(true);
    const results = await Promise.all([confirm(saved), confirm(saved)]); expect(results.every(r => r.retry)).toBe(true);
    expect((await admin.query("select count(*)::int n from core.source_record where batch_id=$1", [batchId])).rows[0].n).toBe(3);
    expect((await admin.query("select sum(p.book_amount_inr)::text total from core.fact_posting p join core.transaction_event e on e.id=p.event_id where e.batch_id=$1", [batchId])).rows[0].total).toMatch(/^0(?:\.0+)?$/);
    expect((await admin.query("select remaining_imports from ops.import_admission")).rows[0].remaining_imports).toBe(99);
    await expect(confirm({ ...saved, rows: [{ ...saved.rows[0]!, amount: "101" }] })).rejects.toMatchObject({ status: 409 });
  });
  it("requires warning acknowledgement and explains ambiguous duplicates; links without double posting", async () => {
    const next = { ...saved, newAccount: undefined, idempotencyKey: randomUUID(), expectedRevision: saved.expectedRevision + 1 };
    const review = await scoped((tx, actor) => reviewImport(tx, actor, next));
    expect(review.matches.length).toBeGreaterThan(0);
    await expect(confirm(next)).rejects.toMatchObject({ status: 400 });
    next.acknowledgements = review.warnings.map(w => w.code);
    await expect(confirm(next)).rejects.toThrow("separate transaction");
    next.decisions = { salary: { action: "link", eventId: review.matches[0]!.eventId, note: "Repeated statement evidence" } };
    const result = await confirm(next);
    expect((await admin.query("select count(*)::int n from core.transaction_event where batch_id=$1", [result.batchId])).rows[0].n).toBe(0);
  });
  it("serializes overlapping confirmations and rejects stale revisions", async () => {
    const first = await base(), second = { ...await base(), expectedRevision: first.expectedRevision };
    const result = await Promise.allSettled([confirm(first), confirm(second)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("appends exact reversal and replacement without mutating original source", async () => {
    const eventId = (await admin.query("select id from core.transaction_event where batch_id=$1", [batchId])).rows[0].id;
    const next = { ...saved, newAccount: undefined, idempotencyKey: randomUUID(), expectedRevision: (await base()).expectedRevision, rows: [{ ...saved.rows[0]!, category: "other_income" }], decisions: { salary: { action: "replace" as const, eventId, note: "Correct category" } } };
    next.acknowledgements = (await scoped((tx, actor) => reviewImport(tx, actor, next))).warnings.map(w => w.code);
    const result = await confirm(next);
    expect((await admin.query("select kind from core.transaction_event where batch_id=$1 order by kind", [result.batchId])).rows).toEqual([{ kind: "income" }, { kind: "reversal" }]);
    expect((await admin.query("select payload->>'category' category from core.source_record where batch_id=$1 and row_number=1", [batchId])).rows[0].category).toBe("salary");
  });
  it("rolls back all writes and reservations on a late reconciliation failure", async () => {
    const next = await base(); next.rows[0] = { ...next.rows[0]!, event_type: "unresolved_reconciliation", category: "" };
    next.decisions.salary = { action: "new", note: "Synthetic missing evidence", resolutionObservationId: randomUUID() };
    next.acknowledgements = ["equity"];
    const before = (await admin.query("select remaining_imports from ops.import_admission")).rows[0].remaining_imports;
    await expect(confirm(next)).rejects.toThrow("Resolution");
    expect((await admin.query("select remaining_imports from ops.import_admission")).rows[0].remaining_imports).toBe(before);
    expect((await admin.query("select count(*)::int n from core.import_batch where idempotency_key=$1", [next.idempotencyKey])).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int n from core.dim_account where id=$1", [next.manifest.accountId])).rows[0].n).toBe(0);
  });
  it("links the opposite side of a transfer without creating a second economic event", async () => {
    const destination = await base(); await confirm(destination);
    const first: Confirmation = { ...await base(), newAccount: undefined, manifest: { ...saved.manifest, openingBalance: "30", closingBalance: "0" }, rows: [{ ...saved.rows[0]!, row_id: "transfer", transaction_ref: "synthetic-transfer", transaction_date: "2026-09-11", direction: "debit", amount: "30", event_type: "transfer", category: "" }], decisions: { transfer: { action: "new", note: "Own savings transfer", offsetAccountId: destination.manifest.accountId } } };
    first.acknowledgements = (await scoped((tx, actor) => reviewImport(tx, actor, first))).warnings.map(w => w.code);
    const result = await confirm(first);
    const transferId = (await admin.query("select id from core.transaction_event where batch_id=$1", [result.batchId])).rows[0].id;
    const opposite: Confirmation = { ...first, idempotencyKey: randomUUID(), expectedRevision: result.revision, manifest: { ...destination.manifest, openingBalance: "0", closingBalance: "30" }, rows: [{ ...first.rows[0]!, direction: "credit", transaction_ref: "synthetic-other-side" }], decisions: { transfer: { action: "link", note: "Opposite bank statement evidence", eventId: transferId } } };
    const review = await scoped((tx, actor) => reviewImport(tx, actor, opposite));
    expect(review.matches.map(m => m.eventId)).toContain(transferId);
    opposite.acknowledgements = review.warnings.map(w => w.code);
    const linked = await confirm(opposite);
    expect((await admin.query("select count(*)::int n from core.transaction_event where batch_id=$1", [linked.batchId])).rows[0].n).toBe(0);
  });
  it("records a traceable unresolved-equity resolution without inventing income", async () => {
    const original = await base(); original.manifest.closingBalance = "110"; original.acknowledgements = ["reconciliation"];
    const result = await confirm(original);
    const observationId = (await admin.query("select o.id from core.fact_statement_observation o join core.source_record s on s.id=o.source_id where s.batch_id=$1 and o.kind='closing'", [result.batchId])).rows[0].id;
    const correction: Confirmation = { ...original, newAccount: undefined, idempotencyKey: randomUUID(), expectedRevision: result.revision, manifest: { ...original.manifest, openingBalance: "0", closingBalance: "10" }, rows: [{ ...original.rows[0]!, amount: "10", transaction_date: "2026-09-30", transaction_ref: "synthetic-resolution", event_type: "unresolved_reconciliation", category: "" }], decisions: { salary: { action: "new", note: "Missing historical evidence remains unknown", resolutionObservationId: observationId } } };
    correction.acknowledgements = (await scoped((tx, actor) => reviewImport(tx, actor, correction))).warnings.map(w => w.code);
    await confirm(correction);
    const resolutions = (await admin.query("select status,resolution_event_id from core.reconciliation_result where observation_id=$1 order by revision", [observationId])).rows;
    expect(resolutions.map(r => r.status)).toEqual(["mismatch", "matched"]);
    expect(resolutions[1].resolution_event_id).not.toBeNull();
  });
  it("commits the complete 5,000-evidence-row envelope without partial batches", async () => {
    await ready();
    const large = await base();
    large.rows = Array.from({ length: 4998 }, (_, i) => ({ ...large.rows[0]!, row_id: `row${i}`, transaction_ref: `synthetic-${i}`, description: `Synthetic income ${i}`, amount: "1", category: i % 2 === 0 ? "" : "salary" }));
    large.decisions = Object.fromEntries(large.rows.map(row => [row.row_id, { action: "new", note: "" }]));
    large.manifest.closingBalance = "4998";
    large.acknowledgements = ["uncategorized"];
    expect(encodedBytes(large)).toBeLessThan(3_000_000);
    const result = await confirm(large);
    expect((await admin.query("select count(*)::int n from core.source_record where batch_id=$1", [result.batchId])).rows[0].n).toBe(5000);
    expect((await admin.query("select count(*)::int n from core.transaction_event where batch_id=$1 and state='confirmed'", [result.batchId])).rows[0].n).toBe(4998);
  }, 60_000);
  it("records an explicit reviewed opening and complete statement for balance calculations", async () => {
    await ready();
    const input = await base();
    input.newAccount!.name = "Synthetic reviewed opening bank";
    input.manifest.openingBalance = "100"; input.manifest.closingBalance = "115";
    input.manifest.openingKnown = true; input.manifest.historyReason = "Earlier history is unavailable.";
    const source = input.rows[0]!;
    input.rows = [
      { ...source, row_id: "opening", transaction_ref: "synthetic-reviewed-opening", transaction_date: "2026-09-01", amount: "100", event_type: "opening_balance", category: "" },
      { ...source, row_id: "income", transaction_ref: "synthetic-balance-income", amount: "20" },
      { ...source, row_id: "expense", transaction_ref: "synthetic-balance-expense", transaction_date: "2026-09-20", direction: "debit", amount: "5", event_type: "expense", category: "" },
    ];
    input.decisions = { opening: { action: "new", note: "Reviewed statement opening; prior history remains unknown." }, income: { action: "new", note: "" }, expense: { action: "new", note: "" } };
    input.acknowledgements = (await scoped((tx, actor) => reviewImport(tx, actor, input))).warnings.map(w => w.code);
    expect((await confirm(input)).state).toBe("committed");
  });
  it("rejects expired and depleted capacity and prevents members renewing verification", async () => {
    await admin.query("update ops.import_admission set remaining_imports=0");
    await expect(confirm(await base())).rejects.toThrow();
    await ready(); await admin.query("update ops.import_admission set verified_until=now()-interval '1 second'");
    await expect(confirm(await base())).rejects.toThrow();
    const { sql } = await import("drizzle-orm");
    await expect(scoped(tx => tx.execute(sql`update ops.import_admission set workflow_verified=true`))).rejects.toThrow();
    await ready();
  });
}
