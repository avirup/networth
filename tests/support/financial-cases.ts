import { it, expect } from "vitest";
import { CATEGORY_DEFINITIONS } from "@/lib/finance/categories";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sql } from "drizzle-orm";
import type { IdentityService } from "@/db/auth/service";

export function financialCases(admin: Pool, service: IdentityService, household: () => string, owner: () => string) {
  let account: string, cash: string, expense: string, category: string, reference: string, eventId: string, sourceId: string, batchId: string;
  async function transaction(work: (client: PoolClient) => Promise<void>) {
    const client=await admin.connect();try{await client.query("begin");await work(client);await client.query("commit");}catch(error){await client.query("rollback");throw error;}finally{client.release();}
  }
  async function batch(client: PoolClient, options: { unbalanced?: boolean; noOutbox?: boolean; single?: boolean; pending?: boolean; scale?: boolean; kind?: string; category?: string; reverses?: string; wrongReversal?: boolean } = {}) {
    const revision=(await client.query("update ops.source_revision set revision=revision+1 where household_id=$1 returning revision",[household()])).rows[0].revision;
    const batch=(await client.query("insert into core.import_batch(household_id,account_id,schema_version,idempotency_key,content_hash,coverage_start,coverage_end,completeness,row_count,request_bytes,revision,reviewed_by) values($1,$2,'bank-v1',$3,$4,'2026-09-01','2026-09-30','complete',1,500,$5,$6) returning id",[household(),account,randomUUID(),'a'.repeat(64),revision,owner()])).rows[0].id;
    const source=(await client.query("insert into core.source_record(household_id,batch_id,row_number,row_hash,payload) values($1,$2,1,$3,'{}') returning id",[household(),batch,'b'.repeat(64)])).rows[0].id;
    const event=(await client.query("insert into core.transaction_event(household_id,batch_id,kind,effective_date,reverses_id) values($1,$2,$3,'2026-09-02',$4) returning id",[household(),batch,options.reverses?'reversal':options.kind??'expense',options.reverses??null])).rows[0].id;
    await client.query("insert into core.event_source_link(household_id,event_id,source_id) values($1,$2,$3)",[household(),event,source]);
    const sign=options.reverses?'100.00':'-100.00';
    await client.query("insert into core.fact_posting(household_id,event_id,line_number,ledger_account_id,native_amount,currency,book_amount_inr) values($1,$2,1,$3,$4,'INR',$4)",[household(),event,cash,options.scale?'-100.0000000000001':sign]);
    if(!options.single)await client.query("insert into core.fact_posting(household_id,event_id,line_number,ledger_account_id,native_amount,currency,book_amount_inr,category_id) values($1,$2,2,$3,$4,'INR',$4,$5)",[household(),event,expense,options.unbalanced?'99.00':options.reverses?'-100.00':'100.00',options.wrongReversal?null:options.category??category]);
    if(!options.pending)await client.query("update core.transaction_event set state='confirmed' where id=$1",[event]);
    if(!options.noOutbox)await client.query("insert into ops.outbox_event(household_id,batch_id,revision) values($1,$2,$3)",[household(),batch,revision]);
    await client.query("insert into ops.rebuild_request(household_id,batch_id,account_id,earliest_date,revision) values($1,$2,$3,'2026-09-01',$4)",[household(),batch,account,revision]);
    return {event,source,batch};
  }
  it("seeds defined household categories and creates scoped cash dimensions",async()=>{
    const login=await service.login('owner@example.test','local recovered synthetic password','finance-tests');reference=login!.reference;
    expect((await admin.query("select count(*)::int n from core.dim_category where household_id=$1",[household()])).rows[0].n).toBe(15);
    expect((await admin.query("select code,name,kind from core.dim_category where household_id=$1 order by code",[household()])).rows).toEqual(CATEGORY_DEFINITIONS.map(([code,name,kind])=>({code,name,kind})).sort((a,b)=>a.code.localeCompare(b.code)));
    account=(await admin.query("insert into core.dim_account(household_id,name,currency,masked_reference) values($1,'Synthetic bank','INR','****1234') returning id",[household()])).rows[0].id;
    cash=(await admin.query("insert into core.ledger_account(household_id,account_id,code,kind,currency) values($1,$2,'bank','asset','INR') returning id",[household(),account])).rows[0].id;
    expense=(await admin.query("insert into core.ledger_account(household_id,code,kind,currency) values($1,'spending','expense','INR') returning id",[household()])).rows[0].id;
    category=(await admin.query("select id from core.dim_category where household_id=$1 and code='grocery'",[household()])).rows[0].id;
    await expect(admin.query("insert into core.dim_account(household_id,name,currency,masked_reference) values($1,'Bad','INR','123456789012')",[household()])).rejects.toMatchObject({code:'23514'});
  });
  it("rejects unbalanced, single-leg, pending and excessive-scale events atomically",async()=>{
    for(const option of [{unbalanced:true},{single:true},{pending:true},{scale:true},{noOutbox:true}])await expect(transaction(async client=>{await batch(client,option);})).rejects.toMatchObject({code:'23514'});
    expect((await admin.query("select count(*)::int n from core.import_batch")).rows[0].n).toBe(0);
    expect((await admin.query("select revision from ops.source_revision where household_id=$1",[household()])).rows[0].revision).toBe(0);
  });
  it("commits evidence, postings, revision and rebuild intent together",async()=>{
    await transaction(async client=>{const value=await batch(client);eventId=value.event;sourceId=value.source;batchId=value.batch;});
    expect((await admin.query("select sum(book_amount_inr)::text total from core.fact_posting where event_id=$1",[eventId])).rows[0].total).toBe('0.00');
    expect((await admin.query("select count(*)::int n from ops.outbox_event where batch_id=$1",[batchId])).rows[0].n).toBe(1);
    await expect(admin.query("update core.fact_posting set book_amount_inr=0 where event_id=$1",[eventId])).rejects.toMatchObject({code:'23514'});
    await expect(admin.query("delete from core.transaction_event where id=$1",[eventId])).rejects.toMatchObject({code:'23514'});
    await expect(admin.query("insert into core.fact_posting(household_id,event_id,line_number,ledger_account_id,native_amount,currency,book_amount_inr) values($1,$2,3,$3,1,'INR',1)",[household(),eventId,cash])).rejects.toMatchObject({code:'23514'});
    await expect(admin.query("insert into core.source_record(household_id,batch_id,row_number,row_hash,payload) values($1,$2,2,$3,'{}')",[household(),batchId,'c'.repeat(64)])).rejects.toMatchObject({code:'23514'});
  });
  it("requires category kind consistency and keeps transfers out of spending",async()=>{
    const income=(await admin.query("select id from core.dim_category where household_id=$1 and code='salary'",[household()])).rows[0].id;
    await expect(transaction(async client=>{await batch(client,{category:income});})).rejects.toMatchObject({code:'23514'});
    await expect(transaction(async client=>{await batch(client,{kind:'transfer'});})).rejects.toMatchObject({code:'23514'});
  });
  it("only permits exact sourced reversals and a single reversal of an event",async()=>{
    await expect(transaction(async client=>{await batch(client,{reverses:eventId,wrongReversal:true});})).rejects.toMatchObject({code:'23514'});
    await transaction(async client=>{await batch(client,{reverses:eventId});});
    await expect(transaction(async client=>{await batch(client,{reverses:eventId});})).rejects.toMatchObject({code:'23505'});
    expect((await admin.query("select sum(book_amount_inr)::text total from core.fact_posting where ledger_account_id=$1",[cash])).rows[0].total).toBe('0.00');
  });
  it("rejects cross-household dimensions and isolates scoped financial reads",async()=>{
    const other=(await admin.query("select id from core.household where id<>$1 limit 1",[household()])).rows[0].id;
    await expect(admin.query("insert into core.ledger_account(household_id,account_id,code,kind,currency) values($1,$2,'cross','asset','INR')",[other,account])).rejects.toMatchObject({code:'23514'});
    const otherInstrument=(await admin.query("select id from core.dim_instrument where household_id=$1 limit 1",[other])).rows[0].id;
    await expect(admin.query("insert into core.holding(household_id,account_id,instrument_id) values($1,$2,$3)",[other,account,otherInstrument])).rejects.toMatchObject({code:'23503'});
    await service.scoped(reference,household(),'read',async tx=>{expect((await tx.execute(sql`select id from core.dim_account`)).rows).toEqual([{id:account}]);expect((await tx.execute(sql`select id from core.source_record where household_id=${other}`)).rows).toHaveLength(0);});
    const viewer=(await admin.query("select u.id from core.auth_user u join core.household_membership m on m.user_id=u.id where m.household_id=$1 and m.role='viewer' limit 1",[household()])).rows[0].id;
    // A verified viewer context cannot insert financial dimensions even through direct SQL.
    await transaction(async client=>{
      await client.query("set local role networth_member");
      await client.query("select set_config('app.household_id',$1,true),set_config('app.user_id',$2,true),set_config('app.session_hash','invalid',true)",[household(),viewer]);
      expect((await client.query("select id from core.fact_posting")).rows).toHaveLength(0);
    });
  });
  it("requires exact non-overlapping ownership totals",async()=>{
    const person=(await admin.query("insert into core.dim_owner(household_id,name) values($1,'Synthetic person') returning id",[household()])).rows[0].id;
    async function allocation(client:PoolClient,fraction:string,start='2026-01-01'){
      const id=(await client.query("insert into core.ownership_allocation(household_id,account_id,valid_from,valid_to) values($1,$2,$3,'2027-01-01') returning id",[household(),account,start])).rows[0].id;
      await client.query("insert into core.ownership_interest(household_id,allocation_id,owner_id,fraction) values($1,$2,$3,$4)",[household(),id,person,fraction]);
    }
    await expect(transaction(client=>allocation(client,'0.5'))).rejects.toMatchObject({code:'23514'});
    await transaction(client=>allocation(client,'1'));
    await expect(transaction(client=>allocation(client,'1','2026-06-01'))).rejects.toMatchObject({code:'23514'});
  });
  it("checks reconciliation against observations without posting another asset",async()=>{
    let observation:string, revision:number;
    await transaction(async client=>{
      const value=await batch(client);
      observation=(await client.query("insert into core.fact_statement_observation(household_id,source_id,account_id,as_of,kind,balance,currency) values($1,$2,$3,'2026-09-30','closing',500,'INR') returning id",[household(),value.source,account])).rows[0].id;
      revision=(await client.query("select revision from ops.source_revision where household_id=$1",[household()])).rows[0].revision;
      await client.query("insert into core.reconciliation_result(household_id,observation_id,revision,status,calculated_balance,difference) values($1,$2,$3,'matched',500,0)",[household(),observation,revision]);
    });
    await expect(admin.query("insert into core.reconciliation_result(household_id,observation_id,revision,status,calculated_balance,difference) values($1,$2,$3,'matched',499,0)",[household(),observation!,revision!])).rejects.toMatchObject({code:'23514'});
    await admin.query("insert into core.reconciliation_result(household_id,observation_id,revision,status,explanation) values($1,$2,$3,'unknown','Opening history missing')",[household(),observation!,revision!]);
    expect((await admin.query("select count(*)::int n from core.fact_posting where ledger_account_id=$1",[cash])).rows[0].n).toBe(3);
  });
  it("keeps observations distinct from assets and unknown reconciliation explicit",async()=>{
    // An observation cannot be attached after a source batch has committed.
    await expect(admin.query("insert into core.fact_statement_observation(household_id,source_id,account_id,as_of,kind,balance,currency) values($1,$2,$3,'2026-09-30','closing',100,'INR')",[household(),sourceId,account])).rejects.toMatchObject({code:'23514'});
    await expect(admin.query("update ops.source_revision set revision=revision+2 where household_id=$1",[household()])).rejects.toMatchObject({code:'23514'});
  });
}
