import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CARD_COLUMNS, normalizeCardRow, parseCardCsv, validateCardBatch, type CardRow } from "@/lib/imports/card-v1";
import { cardOpeningPostings, cardPostings, reconcileCardStatement } from "@/lib/finance/card-posting";
import { bankPostings, reversePostings } from "@/lib/finance/bank-posting";
import { summarizeCardFacilities, type AccountFacilityLink, type CreditFacilityTerm } from "@/lib/finance/card-facility";

const row: CardRow = { schema_version: "card-v1", row_id: "purchase", transaction_ref: "", transaction_date: "2026-09-03",
  description: "Synthetic purchase", direction: "debit", amount: "1200.00", currency: "INR", event_type: "card_purchase", category: "grocery", related_row_id: "" };
const manifest = { schemaVersion: "card-v1", accountId: "00000000-0000-4000-8000-000000000009", currency: "INR",
  coverageStart: "2026-09-01", coverageEnd: "2026-09-30", completeness: "complete", openingOutstanding: "0",
  statementOutstanding: "1200", historyReason: "", paymentDueDate: "2026-10-20", minimumDue: "100" };

describe("card transaction and statement contract", () => {
  it("balances purchases, refunds, interest and fees without bank cash legs", () => {
    for (const kind of ["card_purchase", "card_interest", "card_fee"] as const) {
      const result = cardPostings({ ...row, event_type: kind }, { cardAccount: "card", offsetAccount: "expense", offsetKind: "expense" });
      expect(result.legs.map(leg => leg.bookAmountInr)).toEqual(["-1200.000000000000", "1200.000000000000"]);
      expect(result.legs.map(leg => leg.kind)).toEqual(["liability", "expense"]);
    }
    const purchase = cardPostings(row, { cardAccount: "card", offsetAccount: "expense", offsetKind: "expense" });
    const refund = cardPostings({ ...row, event_type: "card_refund", direction: "credit" }, { cardAccount: "card", offsetAccount: "expense", offsetKind: "expense" });
    expect(refund.legs).toEqual(reversePostings(purchase.legs));
  });
  it("produces the same repayment legs from either statement, ready for one linked event", () => {
    const card = cardPostings({ ...row, event_type: "card_repayment", direction: "credit", category: "" },
      { cardAccount: "card", offsetAccount: "bank", offsetKind: "asset" });
    const bank = bankPostings({ schema_version: "bank-v1", row_id: "repayment", transaction_ref: "", transaction_date: row.transaction_date,
      description: "Synthetic repayment", direction: "debit", amount: row.amount, currency: "INR", event_type: "card_repayment", category: "",
      book_amount_inr: "", fx_rate: "", related_row_id: "" }, { cashAccount: "bank", offsetAccount: "card", offsetKind: "liability" });
    expect(card.legs).toEqual([...bank.legs].reverse());
    expect(card.legs.every(leg => leg.category === null)).toBe(true);
  });
  it("keeps positive debt and card credit openings out of spending and requires review", () => {
    expect(cardOpeningPostings("5000", { cardAccount: "card", equityAccount: "equity", reviewed: true }).legs[0]?.bookAmountInr).toBe("-5000.000000000000");
    expect(cardOpeningPostings("-100", { cardAccount: "card", equityAccount: "equity", reviewed: true }).legs[0]?.bookAmountInr).toBe("100.000000000000");
    expect(cardOpeningPostings("0", { cardAccount: "card", equityAccount: "equity", reviewed: true }).legs).toEqual([]);
    expect(() => cardOpeningPostings("100", { cardAccount: "card", equityAccount: "equity", reviewed: false })).toThrow();
  });
  it("reconciles the downloadable example to 5075 without adding repayments to expenses", async () => {
    const csv = await readFile("public/templates/card-v1-example.csv", "utf8");
    const metadata = JSON.parse(await readFile("public/templates/card-v1-example-manifest.json", "utf8"));
    expect((await readFile("public/templates/card-v1.csv", "utf8")).trim()).toBe(CARD_COLUMNS.join(","));
    const rows = parseCardCsv(csv);
    expect(validateCardBatch(metadata, rows).rows).toHaveLength(5);
    expect(reconcileCardStatement(metadata, rows)).toMatchObject({ status: "matched", calculated: "5075.000000000000", difference: "0.000000000000" });
  });
  it("retains unknowns and mismatches instead of creating balancing entries", () => {
    expect(reconcileCardStatement({ ...manifest, openingOutstanding: null, historyReason: "Not supplied" }, [row]).status).toBe("unknown");
    expect(reconcileCardStatement({ ...manifest, completeness: "partial" }, [row]).status).toBe("unknown");
    expect(reconcileCardStatement({ ...manifest, statementOutstanding: null }, [row]).status).toBe("unknown");
    expect(reconcileCardStatement({ ...manifest, statementOutstanding: "1201" }, [row])).toMatchObject({ status: "mismatch", difference: "1.000000000000" });
    expect(reconcileCardStatement({ ...manifest, openingOutstanding: "-50", statementOutstanding: "1150" }, [row]).status).toBe("matched");
  });
  it.each([
    { amount: "1.001" }, { amount: "1e3" }, { amount: "0" }, { amount: "-10" }, { amount: 1 },
    { currency: "USD" }, { direction: "credit" }, { category: "salary" }, { transaction_date: "2026-02-29" },
    { event_type: "card_repayment", direction: "credit", category: "fees" },
  ])("rejects invalid card input %j", invalid => {
    expect(() => normalizeCardRow({ ...row, ...invalid })).toThrow();
  });
  it("validates coverage, duplicate IDs, due dates and evidence limits", () => {
    expect(() => validateCardBatch(manifest, [row, row])).toThrow();
    expect(() => validateCardBatch(manifest, [{ ...row, transaction_date: "2026-08-31" }])).toThrow();
    expect(() => validateCardBatch(manifest, [{ ...row, related_row_id: row.row_id }])).toThrow();
    expect(() => validateCardBatch({ ...manifest, paymentDueDate: "2026-09-20" }, [row])).toThrow();
    expect(() => validateCardBatch({ ...manifest, minimumDue: "1201" }, [row])).toThrow();
    expect(() => validateCardBatch({ ...manifest, completeness: "balance_only" }, [row])).toThrow();
    expect(() => validateCardBatch(manifest, Array(4999).fill(row))).toThrow();
    expect(() => parseCardCsv("x".repeat(3_000_001))).toThrow();
    expect(() => parseCardCsv("schema_version,row_id\ncard-v1,x")).toThrow();
    expect(() => cardPostings(row, { cardAccount: "card", offsetAccount: "bank", offsetKind: "asset" })).toThrow();
  });
  it("parses quoted descriptions and keeps long decimal amounts exact", () => {
    const csv = CARD_COLUMNS.join(",") + '\ncard-v1,x,,2026-09-03,"Synthetic, groceries",debit,9007199254740993.01,INR,card_purchase,grocery,';
    expect(parseCardCsv(csv)[0]).toMatchObject({ amount: "9007199254740993.010000000000", description: "Synthetic, groceries" });
  });
});

describe("dated credit facilities", () => {
  const asOf = "2026-09-30";
  const terms: CreditFacilityTerm[] = [{ facilityId: "shared", validFrom: "2026-01-01", validTo: null, limitInr: "10000" }];
  const links: AccountFacilityLink[] = ["card-a", "card-b"].map(accountId => ({ accountId, facilityId: "shared", validFrom: "2026-01-01", validTo: null }));
  const positions = [{ accountId: "card-a", asOf, outstandingInr: "3000" }, { accountId: "card-b", asOf, outstandingInr: "2000" }];
  it("counts a shared limit and each household card once", () => {
    const report = summarizeCardFacilities({ asOf, terms, links, positions });
    expect(report.knownNetWorthContributionInr).toBe("-5000.000000000000");
    expect(report.facilities).toHaveLength(1);
    expect(report.facilities[0]).toMatchObject({ limitInr: "10000.000000000000", drawnInr: "5000.000000000000",
      utilizationPercent: "50.000000", availableCreditInr: "5000.000000000000", overLimitInr: "0.000000000000", reason: null });
    expect(() => summarizeCardFacilities({ asOf, terms, links, positions: [...positions, positions[0]!] })).toThrow();
  });
  it("uses the historical limit and preserves over-limit percentages", () => {
    const history: CreditFacilityTerm[] = [
      { ...terms[0]!, limitInr: "4000", validTo: "2026-10-01" },
      { ...terms[0]!, validFrom: "2026-10-01", limitInr: "10000" },
    ];
    const report = summarizeCardFacilities({ asOf, terms: history, links, positions });
    expect(report.facilities[0]).toMatchObject({ utilizationPercent: "125.000000", availableCreditInr: "0.000000000000", overLimitInr: "1000.000000000000" });
  });
  it.each([null, "0"])("keeps utilization unavailable for limit %s", limitInr => {
    expect(summarizeCardFacilities({ asOf, terms: [{ ...terms[0]!, limitInr }], links, positions }).facilities[0]?.utilizationPercent).toBeNull();
  });
  it("does not infer future limits or silently drop missing cards", () => {
    expect(summarizeCardFacilities({ asOf, terms: [{ ...terms[0]!, validFrom: "2026-10-01" }], links, positions }).facilities[0]?.reason).toBe("missing_limit");
    expect(() => summarizeCardFacilities({ asOf, terms, links, positions: positions.slice(0, 1) })).toThrow();
    const report = summarizeCardFacilities({ asOf, terms, links, positions: [positions[0]!, { ...positions[1]!, outstandingInr: null }] });
    expect(report.unknownAccountCount).toBe(1);
    expect(report.facilities[0]).toMatchObject({ reason: "unknown_outstanding", drawnInr: null, utilizationPercent: null, availableCreditInr: null });
    expect(report.knownLiabilitiesInr).toBe("3000.000000000000");
  });
  it("keeps overpayments separate from debt without inflating a facility's credit limit", () => {
    const report = summarizeCardFacilities({ asOf, terms, links, positions: [positions[0]!, { ...positions[1]!, outstandingInr: "-100" }] });
    expect(report).toMatchObject({ knownLiabilitiesInr: "3000.000000000000", knownCreditBalancesInr: "100.000000000000", knownNetWorthContributionInr: "-2900.000000000000" });
    expect(report.facilities[0]).toMatchObject({ drawnInr: "3000.000000000000", availableCreditInr: "7000.000000000000", utilizationPercent: "30.000000" });
  });
  it("rejects overlapping facility/link periods, negative limits and mixed dates", () => {
    expect(() => summarizeCardFacilities({ asOf, terms: [...terms, terms[0]!], links, positions })).toThrow();
    expect(() => summarizeCardFacilities({ asOf, terms, links: [...links, links[0]!], positions })).toThrow();
    expect(() => summarizeCardFacilities({ asOf, terms: [{ ...terms[0]!, limitInr: "-1" }], links, positions })).toThrow();
    expect(() => summarizeCardFacilities({ asOf, terms, links, positions: [{ ...positions[0]!, asOf: "2026-10-01" }] })).toThrow();
  });
});
