import { describe, it, expect } from "vitest";
import { normalizeBankRow, validateBankBatch, type BankRow } from "@/lib/imports/bank-v1";
import { bankPostings, reconcile, reversePostings, fxConversion } from "@/lib/finance/bank-posting";
import { decimal, economicDate, settle } from "@/lib/finance/decimal";
import { ownershipShare } from "@/lib/finance/ownership";
const row: BankRow = { schema_version:"bank-v1",row_id:"1",transaction_ref:"",transaction_date:"2026-09-01",description:"Synthetic salary",direction:"credit",amount:"85000.00",currency:"INR",event_type:"income",category:"salary",book_amount_inr:"",fx_rate:"",related_row_id:"" };
const manifest = { schemaVersion:"bank-v1",accountId:"00000000-0000-4000-8000-000000000001",currency:"INR",coverageStart:"2026-09-01",coverageEnd:"2026-09-30",completeness:"complete",openingBalance:"0",closingBalance:"85000",openingKnown:true,historyReason:"" };
describe("bank-v1 financial contract", () => {
  it("posts income and spending with debit-positive signs and defined categories", () => {
    expect(bankPostings(row,{ cashAccount:"bank",offsetAccount:"salary",offsetKind:"income" }).legs.map(l=>l.bookAmountInr)).toEqual(["85000.000000000000","-85000.000000000000"]);
    const expense=bankPostings({...row,event_type:"expense",direction:"debit",amount:"2450.50",category:"grocery"},{cashAccount:"bank",offsetAccount:"spending",offsetKind:"expense"});
    expect(expense.legs[1]).toMatchObject({bookAmountInr:"2450.500000000000",category:"grocery"});
    expect(bankPostings({...row,event_type:"expense_refund",amount:"500",category:"grocery"},{cashAccount:"bank",offsetAccount:"spending",offsetKind:"expense"}).legs[1]?.bookAmountInr).toBe("-500.000000000000");
    expect(reversePostings(expense.legs)[0]?.bookAmountInr).toBe("2450.500000000000");
  });
  it("keeps transfers and card principal out of spending", () => {
    for(const [type,kind] of [["transfer","asset"],["card_repayment","liability"]] as const){
      const result=bankPostings({...row,event_type:type,direction:"debit",category:"",amount:"1000"},{cashAccount:"bank",offsetAccount:"destination",offsetKind:kind});
      expect(result.legs.map(l=>l.kind)).toEqual(["asset",kind]);
      expect(()=>normalizeBankRow({...row,event_type:type,direction:"debit",category:"fees"})).toThrow();
    }
  });
  it("does not invent opening history or reconciliation adjustments", () => {
    const opening={...row,event_type:"opening_balance" as const,category:""};
    expect(()=>bankPostings(opening,{cashAccount:"bank",offsetAccount:"opening",offsetKind:"equity"})).toThrow();
    expect(bankPostings(opening,{cashAccount:"bank",offsetAccount:"opening",offsetKind:"equity",reviewedAdjustment:true}).quality).toBe("opening_history_unknown");
    expect(reconcile(null,["100"],"100",true).status).toBe("unknown");
    expect(reconcile("50",["100","-25"],"125",true)).toMatchObject({status:"matched",difference:"0.000000000000"});
    expect(reconcile("50",["100","-25"],"126",true)).toMatchObject({status:"mismatch",difference:"1.000000000000"});
  });
  it("requires FX evidence and recognizes known conversion fees and P&L separately", () => {
    expect(()=>normalizeBankRow({...row,currency:"USD"})).toThrow();
    expect(bankPostings({...row,amount:"1.01",currency:"USD",fx_rate:"80"},{cashAccount:"usd",offsetAccount:"salary",offsetKind:"income"}).legs[0]?.bookAmountInr).toBe("80.800000000000");
    const input={sourceAccount:"usd",destinationAccount:"inr",gainAccount:"fx",feeAccount:"fees",sourceCurrency:"USD",sourceAmount:"100",carryingInr:"8000",grossProceedsInr:"8300",feeInr:"50"};
    const result=fxConversion(input);expect(result.status).toBe("complete");
    if(result.status==='complete')expect(result.legs.map(l=>l.bookAmountInr)).toEqual(["-8000.000000000000","8250.000000000000","-300.000000000000","50.000000000000"]);
    expect(fxConversion({...input,carryingInr:null}).status).toBe("unknown");
  });
  it("rejects incorrect categories and retains explicit uncategorized values", () => {
    expect(()=>normalizeBankRow({...row,category:"grocery"})).toThrow();
    expect(()=>normalizeBankRow({...row,category:"invented"})).toThrow();
    expect(normalizeBankRow({...row,category:""}).category).toBe("");
  });
  it("validates decimal precision, real dates, coverage, row IDs and payload limits", () => {
    for(const bad of ["NaN","Infinity","1e2","1,000","0.0000000000001","1".repeat(27)])expect(()=>decimal(bad)).toThrow();
    expect(settle("1.005")).toBe("1.01"); expect(()=>economicDate("2026-02-29")).toThrow();expect(economicDate("2024-02-29")).toBe("2024-02-29");
    expect(validateBankBatch(manifest,[row]).rows).toHaveLength(1);
    expect(()=>validateBankBatch(manifest,[row,row])).toThrow();
    expect(()=>validateBankBatch(manifest,[{...row,transaction_date:"2026-08-31"}])).toThrow();
    expect(()=>validateBankBatch({...manifest,openingKnown:false,openingBalance:null},[row])).toThrow();
    expect(()=>validateBankBatch(manifest,Array(5001).fill(row))).toThrow();
  });
  it("applies holding-specific ownership once and preserves missing ownership", () => {
    const account=[{targetId:"a",validFrom:"2026-01-01",validTo:null,shares:[{ownerId:"me",fraction:"0.5"},{ownerId:"other",fraction:"0.5"}]}];
    const holding=[{...account[0]!,targetId:"h",shares:[{ownerId:"me",fraction:"1"}]}];
    expect(ownershipShare(account,holding,["me"],"2026-09-01").fraction).toBe("1.000000000000000000");
    expect(ownershipShare(account,[],["me"],"2026-09-01").fraction).toBe("0.500000000000000000");
    expect(ownershipShare([],[],["me"],"2026-09-01").fraction).toBeNull();
  });
});

it("distinguishes exact retries from ambiguous identical content", async () => {
  const { duplicateAssessment } = await import("@/lib/imports/duplicates");
  const previous={idempotencyKey:"request-1",contentHash:"same-content",accountId:"account-1"};
  expect(duplicateAssessment(previous,[previous])).toBe("exact_retry");
  expect(duplicateAssessment({...previous,contentHash:"different"},[previous])).toBe("idempotency_conflict");
  expect(duplicateAssessment({...previous,idempotencyKey:"request-2"},[previous])).toBe("review_possible_duplicate");
});
it("uses April–March financial years and avoids overlapping scope components",async()=>{
  const { calendarDate }=await import("@/lib/finance/decimal");
  const { scopedHoldingIds }=await import("@/lib/finance/ownership");
  expect(calendarDate("2026-03-31")).toMatchObject({financialYear:2025,financialQuarter:4});
  expect(calendarDate("2026-04-01")).toMatchObject({financialYear:2026,financialQuarter:1});
  expect(scopedHoldingIds([{id:"holding",accountId:"account"}],["account"],["holding"])).toEqual(["holding"]);
});
it("validates the downloadable synthetic templates against the real contract",async()=>{
  const { readFile }=await import("node:fs/promises");
  // Fixtures contain no quoted commas; production parsing will use PapaParse in Phase 5.
  const text=await readFile("public/templates/bank-v1-example.csv","utf8");
  const [header,...records]=text.trim().split("\n");
  const columns=header!.split(",");
  const rows=records.map(line=>Object.fromEntries(line.split(",").map((value,index)=>[columns[index]!,value])));
  const metadata=JSON.parse(await readFile("public/templates/bank-v1-example-manifest.json","utf8"));
  const batch=validateBankBatch(metadata,rows);
  expect(batch.rows).toHaveLength(5);
  expect(reconcile(metadata.openingBalance,batch.rows.map(row=>decimal(row.amount).mul(row.direction==='credit'?1:-1).toFixed()),metadata.closingBalance,true).status).toBe("matched");
  const { CATEGORY_DEFINITIONS }=await import("@/lib/finance/categories");
  expect((await readFile("public/templates/categories-v1.csv","utf8")).trim().split("\n").slice(1)).toEqual(CATEGORY_DEFINITIONS.map(item=>item.join(",")));
});
