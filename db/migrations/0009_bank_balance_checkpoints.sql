CREATE TABLE "ops"."bank_balance_candidate" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"state" text DEFAULT 'building' NOT NULL,
	"page" integer DEFAULT 0 NOT NULL,
	"cursor_account_id" uuid,
	CONSTRAINT "bank_balance_candidate_state_check" CHECK ("ops"."bank_balance_candidate"."state" in ('building','calculated')),
	CONSTRAINT "bank_balance_candidate_page_check" CHECK ("ops"."bank_balance_candidate"."page">=0)
);
--> statement-breakpoint
CREATE TABLE "reporting"."bank_balance_checkpoint" (
	"household_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"effective_date" date NOT NULL,
	"calculated_balance" numeric,
	"reconciled_balance" numeric,
	"result" jsonb NOT NULL,
	CONSTRAINT "bank_balance_checkpoint_run_id_account_id_effective_date_pk" PRIMARY KEY("run_id","account_id","effective_date")
);
--> statement-breakpoint
ALTER TABLE "ops"."bank_balance_candidate" ADD CONSTRAINT "bank_balance_candidate_household_id_run_id_generation_id_bank_candidate_household_id_run_id_generation_id_fk" FOREIGN KEY ("household_id","run_id","generation_id") REFERENCES "ops"."bank_candidate"("household_id","run_id","generation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporting"."bank_balance_checkpoint" ADD CONSTRAINT "bank_balance_checkpoint_currency_dim_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."dim_currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporting"."bank_balance_checkpoint" ADD CONSTRAINT "bank_balance_checkpoint_household_id_run_id_generation_id_bank_candidate_household_id_run_id_generation_id_fk" FOREIGN KEY ("household_id","run_id","generation_id") REFERENCES "ops"."bank_candidate"("household_id","run_id","generation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporting"."bank_balance_checkpoint" ADD CONSTRAINT "bank_balance_checkpoint_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$ DECLARE spec text; sn text; tab text; BEGIN
 FOREACH spec IN ARRAY ARRAY['ops.bank_balance_candidate','reporting.bank_balance_checkpoint'] LOOP
 sn:=split_part(spec,'.',1); tab:=split_part(spec,'.',2);
 EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',sn,tab);
 EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',sn,tab);
 EXECUTE format('CREATE POLICY %I ON %I.%I TO %I USING(true) WITH CHECK(true)',tab||'_admin',sn,tab,current_user);
 EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,networth_auth,networth_member,networth_worker',sn,tab);
 END LOOP;
END $$;
CREATE POLICY bank_balance_candidate_member ON ops.bank_balance_candidate FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
GRANT SELECT ON ops.bank_balance_candidate TO networth_member;
CREATE FUNCTION ops.claim_bank_balance_attempt(target uuid, household uuid, expected_page integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$
DECLARE candidate ops.bank_balance_candidate; bank ops.bank_candidate; run ops.calculation_run; budget ops.calculation_budget; step_number integer; pause_reason text; token uuid; BEGIN
 SELECT * INTO run FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND OR run.state<>'prepared' THEN RAISE EXCEPTION 'prepared calculation required' USING ERRCODE='23514'; END IF;
 SELECT * INTO bank FROM ops.bank_candidate WHERE run_id=target;
 IF NOT FOUND OR bank.state<>'calculated' THEN RAISE EXCEPTION 'calculated bank candidate required' USING ERRCODE='23514'; END IF;
 INSERT INTO ops.bank_balance_candidate(run_id,household_id,generation_id) VALUES(target,household,bank.generation_id) ON CONFLICT DO NOTHING;
 SELECT * INTO candidate FROM ops.bank_balance_candidate WHERE run_id=target;
 IF NOT FOUND OR expected_page IS NULL OR expected_page<0 OR expected_page>candidate.page THEN RAISE EXCEPTION 'invalid bank checkpoint' USING ERRCODE='23514'; END IF;
 IF expected_page<candidate.page OR candidate.state='calculated' THEN RETURN jsonb_build_object('status','unchanged','candidate',to_jsonb(candidate)); END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF budget.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('status','busy','candidate',to_jsonb(candidate)); END IF;
 IF budget.state='paused' THEN RETURN jsonb_build_object('status','paused','reason',budget.reason,'candidate',to_jsonb(candidate)); END IF;
 -- Balance step numbers follow both completed planning and bank ranges, so tokens cannot run planning work.
 step_number:=run.page+bank.page+2+candidate.page;
 IF budget.step_page<>step_number THEN budget.step_attempts:=0; END IF;
 IF budget.window_attempts>=100 THEN pause_reason:='window_limit';
 ELSIF budget.step_attempts>=4 THEN pause_reason:='retry_limit';
 ELSIF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())+819200>=400000000 THEN pause_reason:='capacity';
 ELSE
  UPDATE ops.execution_capacity SET remaining_attempts=remaining_attempts-1,remaining_storage_bytes=remaining_storage_bytes-819200
   WHERE singleton AND verified_until>clock_timestamp() AND remaining_attempts>=1 AND remaining_storage_bytes>=819200;
  IF NOT FOUND THEN pause_reason:='capacity'; END IF;
 END IF;
 IF pause_reason IS NOT NULL THEN
  UPDATE ops.calculation_budget SET state='paused',reason=pause_reason,lease_token=NULL,lease_until=NULL WHERE run_id=target;
  RETURN jsonb_build_object('status','paused','reason',pause_reason,'candidate',to_jsonb(candidate));
 END IF;
 token:=gen_random_uuid();
 UPDATE ops.calculation_budget SET window_attempts=window_attempts+1,total_attempts=total_attempts+1,step_page=step_number,
 step_attempts=budget.step_attempts+1,lease_token=token,lease_until=clock_timestamp()+interval '30 seconds' WHERE run_id=target;
 RETURN jsonb_build_object('status','claimed','token',token,'candidate',to_jsonb(candidate));
END $$;

--> statement-breakpoint
CREATE FUNCTION ops.bank_balance_input(target uuid, household uuid, token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE run ops.calculation_run; bank ops.bank_candidate; candidate ops.bank_balance_candidate; budget ops.calculation_budget;
 account core.dim_account; postings jsonb; batches jsonb; closing jsonb; first_date date; result jsonb;
BEGIN
 SELECT * INTO run FROM ops.calculation_run WHERE id=target AND household_id=household FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT bank FROM ops.bank_candidate WHERE run_id=target;
 SELECT * INTO STRICT candidate FROM ops.bank_balance_candidate WHERE run_id=target;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target;
 IF bank.state<>'calculated' OR candidate.state<>'building' OR token IS NULL OR budget.lease_token IS DISTINCT FROM token
 OR budget.lease_until<=clock_timestamp() OR budget.step_page<>run.page+bank.page+2+candidate.page
 THEN RAISE EXCEPTION 'expired balance claim' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp())
 OR NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 SELECT a.* INTO account FROM ops.calculation_account ca JOIN core.dim_account a ON a.id=ca.account_id AND a.household_id=ca.household_id
 WHERE ca.run_id=target AND ca.household_id=household AND a.kind IN ('bank','cash')
 AND (candidate.cursor_account_id IS NULL OR a.id>candidate.cursor_account_id) ORDER BY a.id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO postings FROM (
    select p.id,e.id as "eventId",e.effective_date::text as date,e.kind,original.kind as "originalKind",
      e.quality,p.native_amount::text as native,p.book_amount_inr::text as book,p.currency,
      nullif(btrim(e.review_note),'') is not null as reviewed,
      exists(select from core.transaction_event reversal
        join core.import_batch rb on rb.id=reversal.batch_id and rb.household_id=reversal.household_id
        where reversal.household_id=e.household_id and reversal.reverses_id=e.id
          and rb.revision<=run.source_revision and reversal.effective_date<=bank.as_of) as reversed
    from core.fact_posting p
    join core.ledger_account l on l.id=p.ledger_account_id and l.household_id=p.household_id
    join core.transaction_event e on e.id=p.event_id and e.household_id=p.household_id
    join core.import_batch b on b.id=e.batch_id and b.household_id=e.household_id
    left join core.transaction_event original on original.id=e.reverses_id and original.household_id=e.household_id
    where p.household_id=household and l.account_id=account.id
      and l.kind='asset' and e.state='confirmed' and b.revision<=run.source_revision
      and e.effective_date<=bank.as_of
    order by e.effective_date,e.id,p.id limit 5001
  ) x;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO batches FROM (
    select b.id,b.coverage_start::text as start,b.coverage_end::text as end,b.completeness,
      -- An import-time match alone is insufficient after its linked events change.
      exists(select from core.fact_statement_observation o
        join core.source_record s on s.id=o.source_id and s.household_id=o.household_id
        join core.reconciliation_result rr on rr.observation_id=o.id and rr.household_id=o.household_id
        where s.batch_id=b.id and s.household_id=b.household_id and o.account_id=b.account_id and o.currency=account.currency and o.kind='closing'
          and rr.revision=b.revision and rr.status='matched')
      and not exists(select from core.source_record s
        join core.event_source_link link on link.source_id=s.id and link.household_id=s.household_id
        join core.transaction_event e on e.id=link.event_id and e.household_id=link.household_id
        where s.batch_id=b.id and s.household_id=b.household_id
          and (e.kind='reversal' or (e.batch_id=b.id and e.replaces_id is not null) or exists(
            select from core.transaction_event reversal
            join core.import_batch rb on rb.id=reversal.batch_id and rb.household_id=reversal.household_id
            where reversal.household_id=e.household_id and reversal.reverses_id=e.id
              and rb.revision<=run.source_revision and reversal.effective_date<=bank.as_of))) as supported
    from core.import_batch b
    where b.household_id=household and b.account_id=account.id
      and b.revision<=run.source_revision and b.coverage_start<=bank.as_of
    order by b.coverage_start,b.id limit 1001
  ) x;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO closing FROM (
    select o.id as "evidenceId",o.as_of::text as date,o.balance::text as balance
    from core.fact_statement_observation o
    join core.source_record s on s.id=o.source_id and s.household_id=o.household_id
    join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id
    where o.household_id=household and o.account_id=account.id and o.currency=account.currency
      and o.kind='closing' and o.as_of=bank.as_of and b.revision<=run.source_revision
    order by o.id limit 1001
  ) x;

 IF jsonb_array_length(postings)>5000 OR jsonb_array_length(batches)>1000 OR jsonb_array_length(closing)>1000
 THEN RAISE EXCEPTION 'balance evidence exceeds bounded window' USING ERRCODE='23514'; END IF;
 SELECT min(d) INTO first_date FROM (
 SELECT bank.as_of d UNION ALL SELECT (v->>'date')::date FROM jsonb_array_elements(postings) v
 UNION ALL SELECT (v->>'start')::date FROM jsonb_array_elements(batches) v) dates;
 result:=jsonb_build_object('scope',jsonb_build_object('householdId',household,'sourceRevision',run.source_revision,'accountId',account.id,'currency',account.currency,'start',first_date,'asOf',bank.as_of),
 'postings',postings,'batches',batches,'closing',closing);
 IF octet_length(result::text)>3000000 THEN RAISE EXCEPTION 'balance evidence exceeds response budget' USING ERRCODE='23514'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION ops.claim_bank_balance_attempt(uuid,uuid,integer),ops.bank_balance_input(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_bank_balance_attempt(uuid,uuid,integer),ops.bank_balance_input(uuid,uuid,uuid) TO networth_worker;
--> statement-breakpoint
-- Independent NUMERIC evaluation of the same bounded, trusted source evidence.
-- This helper is private; workers cannot supply substitute evidence to the commit.
CREATE FUNCTION ops.expected_bank_balance(inputs jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
WITH p AS (
 SELECT x.*,CASE WHEN kind='reversal' THEN "originalKind" ELSE kind END event_kind
 FROM jsonb_to_recordset(inputs->'postings') x(id uuid,"eventId" uuid,date date,kind text,"originalKind" text,quality text,native numeric,book numeric,currency text,reversed boolean,reviewed boolean)
), daily AS (
 SELECT date,sum(native) native,sum(CASE WHEN event_kind='opening_balance' THEN native ELSE 0 END) opening,
 sum(CASE WHEN event_kind='unresolved_reconciliation' THEN native ELSE 0 END) adjustment,bool_or(quality<>'complete') incomplete
 FROM p GROUP BY date
), active AS (SELECT * FROM p WHERE kind='opening_balance' AND NOT reversed), anchor AS (
 SELECT a.* FROM active a WHERE (SELECT count(*) FROM active)=1
 AND a.date=(inputs->'scope'->>'start')::date AND a.reviewed AND a.quality='opening_history_unknown'
 AND a.native=(SELECT opening FROM daily WHERE date=a.date)
 AND NOT EXISTS(SELECT FROM daily WHERE date<>a.date AND opening<>0)
), coverage AS (
 SELECT coalesce(range_agg(daterange(x.start,x."end",'[]')) FILTER(WHERE x.completeness='complete' AND x.supported)
 @> daterange((inputs->'scope'->>'start')::date,(inputs->'scope'->>'asOf')::date,'[]'),false) complete
 FROM jsonb_to_recordset(inputs->'batches') x(start date,"end" date,completeness text,supported boolean)
), observed AS (
 SELECT count(DISTINCT balance) n,CASE WHEN count(DISTINCT balance)=1 THEN min(balance) END balance
 FROM jsonb_to_recordset(inputs->'closing') x(balance numeric)
), amounts AS (
 SELECT CASE WHEN EXISTS(SELECT FROM anchor) THEN (SELECT sum(native) FROM p) END calculated,
 observed.balance observed,observed.n,coverage.complete,
 EXISTS(SELECT FROM p WHERE event_kind='unresolved_reconciliation' OR quality='unresolved')
 OR EXISTS(SELECT FROM daily d WHERE adjustment<>0 OR (incomplete AND NOT (EXISTS(SELECT FROM anchor a WHERE a.date=d.date) AND opening<>0))) unresolved
 FROM coverage,observed
), differences AS (
 SELECT *,CASE WHEN complete THEN observed-calculated END difference FROM amounts
), reasoned AS (
 SELECT *,array_remove(ARRAY[
 CASE WHEN calculated IS NULL THEN 'missing_opening' END,
 CASE WHEN NOT complete THEN 'coverage_gap' END,
 CASE WHEN n=0 THEN 'missing_closing' END,
 CASE WHEN n>1 THEN 'conflicting_closing' END,
 CASE WHEN difference<>0 THEN 'balance_mismatch' END,
 CASE WHEN unresolved THEN 'unresolved_evidence' END],NULL) reasons FROM differences
)
SELECT inputs->'scope' || jsonb_build_object('ruleVersion','bank-balance-v1',
 'calculatedBalance',calculated::numeric(62,12)::text,'observedBalance',observed::numeric(62,12)::text,
 'difference',difference::numeric(62,12)::text,'reconciledBalance',CASE WHEN cardinality(reasons)=0 THEN calculated::numeric(62,12)::text END,
 'status',CASE WHEN cardinality(reasons)=0 THEN 'reconciled' ELSE 'incomplete' END,'history','unknown','reasons',to_jsonb(reasons),
 'openingEvidenceId',(SELECT "eventId" FROM anchor),
 'coverageEvidenceIds',coalesce((SELECT jsonb_agg(v->>'id' ORDER BY v->>'id') FROM jsonb_array_elements(inputs->'batches') v),'[]'::jsonb),
 'closingEvidenceIds',coalesce((SELECT jsonb_agg(v->>'evidenceId' ORDER BY v->>'evidenceId') FROM jsonb_array_elements(inputs->'closing') v),'[]'::jsonb))
 FROM reasoned;
$$;
REVOKE ALL ON FUNCTION ops.expected_bank_balance(jsonb) FROM PUBLIC;
CREATE FUNCTION ops.commit_bank_balance(target uuid, household uuid, token uuid, payload jsonb)
RETURNS SETOF ops.bank_balance_candidate LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,core,pg_temp AS $$
DECLARE candidate ops.bank_balance_candidate; inputs jsonb; expected jsonb; account uuid; more boolean; BEGIN
 PERFORM 1 FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT candidate FROM ops.bank_balance_candidate WHERE run_id=target;
 inputs:=ops.bank_balance_input(target,household,token);
 IF inputs IS NULL THEN
  IF payload IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'unexpected balance result' USING ERRCODE='23514'; END IF;
  more:=false;
 ELSE
  IF payload IS NULL OR octet_length(payload::text)>3000000 THEN RAISE EXCEPTION 'invalid balance result' USING ERRCODE='23514'; END IF;
  IF (SELECT count(DISTINCT v->>'date') FROM jsonb_array_elements(inputs->'postings') v)>1000
  OR EXISTS(SELECT FROM jsonb_array_elements(inputs->'postings') v WHERE
   coalesce(v->>'originalKind',v->>'kind') NOT IN ('income','expense','expense_refund','income_reversal','transfer','card_repayment','opening_balance','unresolved_reconciliation'))
  THEN RAISE EXCEPTION 'unsupported balance source window' USING ERRCODE='23514'; END IF;
  expected:=ops.expected_bank_balance(inputs);
  IF payload IS DISTINCT FROM expected THEN RAISE EXCEPTION 'balance result does not reconcile to captured evidence' USING ERRCODE='23514'; END IF;
  IF pg_database_size(current_database())>=400000000 THEN RAISE EXCEPTION 'storage capacity required' USING ERRCODE='P0001'; END IF;
  account:=(inputs->'scope'->>'accountId')::uuid;
  INSERT INTO reporting.bank_balance_checkpoint(household_id,run_id,generation_id,account_id,currency,effective_date,calculated_balance,reconciled_balance,result)
  VALUES(household,target,candidate.generation_id,account,inputs->'scope'->>'currency',(inputs->'scope'->>'asOf')::date,
   (expected->>'calculatedBalance')::numeric,(expected->>'reconciledBalance')::numeric,expected);
  SELECT EXISTS(SELECT FROM ops.calculation_account ca JOIN core.dim_account a ON a.id=ca.account_id AND a.household_id=ca.household_id
   WHERE ca.run_id=target AND ca.household_id=household AND a.kind IN ('bank','cash') AND a.id>account) INTO more;
 END IF;
 UPDATE ops.bank_balance_candidate SET page=page+1,cursor_account_id=coalesce(account,cursor_account_id),state=CASE WHEN more THEN 'building' ELSE 'calculated' END
 WHERE run_id=target RETURNING * INTO candidate;
 UPDATE ops.calculation_budget SET lease_token=NULL,lease_until=NULL,
 state=CASE WHEN window_attempts>=100 AND more THEN 'paused' ELSE 'ready' END,
 reason=CASE WHEN window_attempts>=100 AND more THEN 'window_limit' ELSE NULL END WHERE run_id=target;
 RETURN NEXT candidate;
END $$;
REVOKE ALL ON FUNCTION ops.commit_bank_balance(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.commit_bank_balance(uuid,uuid,uuid,jsonb) TO networth_worker;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops.resume_calculation_budget(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; budget ops.calculation_budget; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target FOR UPDATE;
 IF NOT FOUND OR core.member_role(candidate.household_id) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF budget.state<>'paused' OR NOT (candidate.state='planning' OR EXISTS(SELECT FROM ops.bank_candidate WHERE run_id=target AND state='building') OR EXISTS(SELECT FROM ops.bank_balance_candidate WHERE run_id=target AND state='building')) THEN RAISE EXCEPTION 'calculation is not resumable' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp() AND remaining_attempts>=1 AND remaining_storage_bytes>=819200)
 OR pg_database_size(current_database())+819200>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 UPDATE ops.calculation_budget SET state='ready',reason=NULL,window_number=window_number+1,window_attempts=0,
 step_page=candidate.page,step_attempts=0,lease_token=NULL,lease_until=NULL WHERE run_id=target;
END $$;

UPDATE core.system_installation SET schema_version=8;
