CREATE SCHEMA IF NOT EXISTS reporting;
CREATE TABLE ops.bank_candidate (
 run_id uuid PRIMARY KEY,
 household_id uuid NOT NULL,
 generation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 as_of date NOT NULL CHECK(as_of BETWEEN '1900-01-01' AND '9999-12-31'),
 rule_version text NOT NULL DEFAULT 'bank-movements-v1' CHECK(rule_version='bank-movements-v1'),
 state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','calculated')),
 page integer NOT NULL DEFAULT 0 CHECK(page>=0),
 cursor_date date,
 cursor_id uuid,
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count>=0),
 FOREIGN KEY(household_id,run_id) REFERENCES ops.calculation_run(household_id,id),
 UNIQUE(household_id,run_id,generation_id),
 CHECK((cursor_date IS NULL)=(cursor_id IS NULL))
);
CREATE TABLE reporting.bank_account_movement (
 household_id uuid NOT NULL, run_id uuid NOT NULL, generation_id uuid NOT NULL,
 account_id uuid NOT NULL, currency text NOT NULL, ledger_kind text NOT NULL CHECK(ledger_kind IN ('asset','liability')),
 effective_date date NOT NULL,
 native_delta numeric NOT NULL, book_delta_inr numeric NOT NULL, cash_delta numeric NOT NULL,
 opening_delta numeric NOT NULL, unresolved_delta numeric NOT NULL,
 posting_count bigint NOT NULL CHECK(posting_count>0), incomplete_evidence boolean NOT NULL,
 PRIMARY KEY(run_id,account_id,currency,ledger_kind,effective_date),
 FOREIGN KEY(household_id,run_id,generation_id) REFERENCES ops.bank_candidate(household_id,run_id,generation_id),
 FOREIGN KEY(household_id,account_id) REFERENCES core.dim_account(household_id,id),
 FOREIGN KEY(currency) REFERENCES core.dim_currency(code)
);
CREATE TABLE reporting.bank_category_movement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id uuid NOT NULL, run_id uuid NOT NULL, generation_id uuid NOT NULL,
 account_id uuid NOT NULL, month date NOT NULL CHECK(extract(day FROM month)=1),
 kind text NOT NULL CHECK(kind IN ('income','expense')), category_id uuid,
 amount_inr numeric NOT NULL, posting_count bigint NOT NULL CHECK(posting_count>0),
 CONSTRAINT bank_category_grain UNIQUE NULLS NOT DISTINCT(run_id,account_id,month,kind,category_id),
 FOREIGN KEY(household_id,run_id,generation_id) REFERENCES ops.bank_candidate(household_id,run_id,generation_id),
 FOREIGN KEY(household_id,account_id) REFERENCES core.dim_account(household_id,id),
 FOREIGN KEY(household_id,category_id) REFERENCES core.dim_category(household_id,id)
);
DO $$ DECLARE spec text; schema_name text; tab text; BEGIN
 FOREACH spec IN ARRAY ARRAY['ops.bank_candidate','reporting.bank_account_movement','reporting.bank_category_movement'] LOOP
 schema_name:=split_part(spec,'.',1); tab:=split_part(spec,'.',2);
 EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',schema_name,tab);
 EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',schema_name,tab);
 EXECUTE format('CREATE POLICY %I ON %I.%I TO %I USING(true) WITH CHECK(true)',tab||'_admin',schema_name,tab,current_user);
 EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,networth_auth,networth_member,networth_worker',schema_name,tab);
 END LOOP;
END $$;
CREATE POLICY bank_candidate_member ON ops.bank_candidate FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
GRANT SELECT ON ops.bank_candidate TO networth_member;
-- Candidate financial rows are intentionally not exposed to member/dashboard reads.
--> statement-breakpoint
CREATE FUNCTION ops.begin_bank_candidate(target uuid, household uuid, requested_date date)
RETURNS SETOF ops.bank_candidate LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$
DECLARE candidate ops.bank_candidate; BEGIN
 PERFORM 1 FROM ops.calculation_run WHERE id=target AND household_id=household AND state='prepared' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'prepared calculation required' USING ERRCODE='23514'; END IF;
 SELECT * INTO candidate FROM ops.bank_candidate WHERE run_id=target;
 IF FOUND THEN
  IF candidate.as_of IS DISTINCT FROM requested_date THEN RAISE EXCEPTION 'candidate date is fixed' USING ERRCODE='23514'; END IF;
  RETURN NEXT candidate; RETURN;
 END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp() AND remaining_attempts>0 AND remaining_storage_bytes>=819200)
 OR pg_database_size(current_database())+819200>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 RETURN QUERY INSERT INTO ops.bank_candidate(run_id,household_id,as_of) VALUES(target,household,requested_date) RETURNING *;
END $$;
CREATE FUNCTION ops.claim_bank_attempt(target uuid, household uuid, expected_page integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$
DECLARE candidate ops.bank_candidate; run ops.calculation_run; budget ops.calculation_budget; step_number integer; pause_reason text; token uuid; BEGIN
 SELECT * INTO run FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND OR run.state<>'prepared' THEN RAISE EXCEPTION 'prepared calculation required' USING ERRCODE='23514'; END IF;
 SELECT * INTO candidate FROM ops.bank_candidate WHERE run_id=target;
 IF NOT FOUND OR expected_page IS NULL OR expected_page<0 OR expected_page>candidate.page THEN RAISE EXCEPTION 'invalid bank checkpoint' USING ERRCODE='23514'; END IF;
 IF expected_page<candidate.page OR candidate.state='calculated' THEN RETURN jsonb_build_object('status','unchanged','candidate',to_jsonb(candidate)); END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF budget.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('status','busy','candidate',to_jsonb(candidate)); END IF;
 IF budget.state='paused' THEN RETURN jsonb_build_object('status','paused','reason',budget.reason,'candidate',to_jsonb(candidate)); END IF;
 -- Bank step numbers follow the complete planning range, so tokens cannot run planning work.
 step_number:=run.page+1+candidate.page;
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
CREATE FUNCTION ops.bank_page_input(target uuid, household uuid, token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.bank_candidate; run ops.calculation_run; budget ops.calculation_budget; result jsonb; BEGIN
 SELECT * INTO run FROM ops.calculation_run WHERE id=target AND household_id=household FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT candidate FROM ops.bank_candidate WHERE run_id=target;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target;
 IF candidate.state<>'building' OR token IS NULL OR budget.lease_token IS DISTINCT FROM token
 OR budget.lease_until<=clock_timestamp() OR budget.step_page<>run.page+1+candidate.page
 THEN RAISE EXCEPTION 'expired bank claim' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp())
 OR NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 WITH headers AS MATERIALIZED (
  SELECT e.*,b.revision,original.kind AS reversed_kind FROM core.transaction_event e
  JOIN core.import_batch b ON b.id=e.batch_id AND b.household_id=e.household_id
  LEFT JOIN core.transaction_event original ON original.id=e.reverses_id AND original.household_id=e.household_id
  WHERE e.household_id=household AND e.state='confirmed' AND b.revision<=run.source_revision AND e.effective_date<=candidate.as_of
  AND (candidate.cursor_id IS NULL OR (e.effective_date,e.id)>(candidate.cursor_date,candidate.cursor_id))
  AND EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id
   JOIN ops.calculation_account a ON a.account_id=l.account_id AND a.household_id=l.household_id
   WHERE p.event_id=e.id AND p.household_id=household AND a.run_id=target)
  ORDER BY e.effective_date,e.id LIMIT 101
 ), selected AS MATERIALIZED (SELECT * FROM headers ORDER BY effective_date,id LIMIT 100)
 SELECT jsonb_build_object('context',jsonb_build_object('householdId',household,'sourceRevision',run.source_revision,'asOf',candidate.as_of),
 'events',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'householdId',household,'revision',e.revision,'effectiveDate',e.effective_date,
 'kind',e.kind,'reversedKind',e.reversed_kind,'quality',e.quality,'legs',
  (SELECT coalesce(jsonb_agg(to_jsonb(leg)),'[]'::jsonb) FROM (
   SELECT p.id,p.ledger_account_id AS "ledgerAccountId",l.account_id AS "accountId",l.kind,p.currency,
    p.native_amount::text AS "nativeAmount",p.book_amount_inr::text AS "bookAmountInr",p.category_id AS "categoryId"
   FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id AND l.household_id=p.household_id
   WHERE p.event_id=e.id AND p.household_id=household ORDER BY p.line_number,p.id LIMIT 3
  ) leg)) ORDER BY e.effective_date,e.id) FROM selected e),'[]'::jsonb),
 'hasMore',(SELECT count(*)>100 FROM headers),
 'lastCursor',(SELECT jsonb_build_object('date',effective_date,'eventId',id) FROM selected ORDER BY effective_date DESC,id DESC LIMIT 1)) INTO result;
 IF octet_length(result::text)>3000000 THEN RAISE EXCEPTION 'bank input exceeds response budget' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(result->'events') e WHERE jsonb_array_length(e->'legs')<>2
  OR coalesce(e->>'reversedKind',e->>'kind') NOT IN ('income','expense','expense_refund','income_reversal','transfer','card_repayment','opening_balance','unresolved_reconciliation'))
 THEN RAISE EXCEPTION 'unsupported bank input shape' USING ERRCODE='23514'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION ops.begin_bank_candidate(uuid,uuid,date),ops.claim_bank_attempt(uuid,uuid,integer),ops.bank_page_input(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.begin_bank_candidate(uuid,uuid,date),ops.claim_bank_attempt(uuid,uuid,integer),ops.bank_page_input(uuid,uuid,uuid) TO networth_worker;
--> statement-breakpoint
-- Independent NUMERIC reconciliation of this bounded page before candidate mutation.
CREATE FUNCTION ops.bank_expected_contributions(inputs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH events AS (SELECT value e FROM jsonb_array_elements(inputs->'events')), legs AS (
  SELECT e,coalesce(e->>'reversedKind',e->>'kind') AS event_kind,p.*
  FROM events CROSS JOIN LATERAL jsonb_to_recordset(e->'legs') AS p("accountId" uuid,kind text,currency text,"nativeAmount" numeric,"bookAmountInr" numeric,"categoryId" uuid)
 ), accounts AS (
  SELECT "accountId",currency,kind AS "ledgerKind",(e->>'effectiveDate')::date AS date,
   sum("nativeAmount") AS "nativeDelta",sum("bookAmountInr") AS "bookDeltaInr",
   sum(CASE WHEN kind='asset' AND event_kind NOT IN ('opening_balance','unresolved_reconciliation') THEN "nativeAmount" ELSE 0 END) AS "cashDelta",
   sum(CASE WHEN event_kind='opening_balance' THEN "nativeAmount" ELSE 0 END) AS "openingDelta",
   sum(CASE WHEN event_kind='unresolved_reconciliation' THEN "nativeAmount" ELSE 0 END) AS "unresolvedDelta",
   count(*) AS "postingCount",bool_or(e->>'quality'<>'complete') AS "incompleteEvidence"
  FROM legs WHERE kind IN ('asset','liability') GROUP BY "accountId",currency,kind,e->>'effectiveDate'
 ), categories AS (
  SELECT (SELECT (a->>'accountId')::uuid FROM jsonb_array_elements(e->'legs') a WHERE a->>'kind'='asset' LIMIT 1) AS "accountId",
   date_trunc('month',(e->>'effectiveDate')::date)::date AS month,kind,"categoryId",
   sum(CASE WHEN kind='income' THEN -"bookAmountInr" ELSE "bookAmountInr" END) AS "amountInr",count(*) AS "postingCount"
  FROM legs WHERE kind IN ('income','expense') GROUP BY 1,2,3,4
 ) SELECT jsonb_build_object(
 'accountMovements',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY "accountId",currency,"ledgerKind",date) FROM accounts a),'[]'::jsonb),
 'categoryMovements',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY "accountId",month,kind,"categoryId") FROM categories c),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION ops.bank_expected_contributions(jsonb) FROM PUBLIC;
CREATE FUNCTION ops.commit_bank_page(target uuid, household uuid, token uuid, payload jsonb)
RETURNS SETOF ops.bank_candidate LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,pg_temp AS $$
DECLARE candidate ops.bank_candidate; inputs jsonb; actual jsonb; expected jsonb; more boolean; BEGIN
 PERFORM 1 FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT candidate FROM ops.bank_candidate WHERE run_id=target;
 -- The source cursor and context always come from durable state, never from worker output.
 inputs:=ops.bank_page_input(target,household,token);
 IF payload IS NULL OR octet_length(payload::text)>3000000
 OR payload->>'ruleVersion' IS DISTINCT FROM candidate.rule_version
 OR payload->>'householdId' IS DISTINCT FROM household::text
 OR payload->'sourceRevision' IS DISTINCT FROM inputs->'context'->'sourceRevision'
 OR payload->>'asOf' IS DISTINCT FROM candidate.as_of::text
 OR payload->'eventCount' IS DISTINCT FROM to_jsonb(jsonb_array_length(inputs->'events'))
 OR jsonb_typeof(payload->'accountMovements') IS DISTINCT FROM 'array'
 OR jsonb_typeof(payload->'categoryMovements') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'invalid bank page result' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(payload->'accountMovements')>200 OR jsonb_array_length(payload->'categoryMovements')>100
 THEN RAISE EXCEPTION 'bank result exceeds row bound' USING ERRCODE='23514'; END IF;
 -- Reject numerical JSON money, infinities, exponent notation and oversized decimal strings.
 IF EXISTS(SELECT FROM jsonb_array_elements(payload->'accountMovements') a CROSS JOIN LATERAL jsonb_each(a) v
  WHERE v.key IN ('nativeDelta','bookDeltaInr','cashDelta','openingDelta','unresolvedDelta') AND
   (jsonb_typeof(v.value)<>'string' OR (v.value#>>'{}') !~ '^-?(0|[1-9][0-9]{0,29})(\.[0-9]{1,12})?$'))
 OR EXISTS(SELECT FROM jsonb_array_elements(payload->'categoryMovements') a WHERE jsonb_typeof(a->'amountInr') IS DISTINCT FROM 'string'
  OR a->>'amountInr' !~ '^-?(0|[1-9][0-9]{0,29})(\.[0-9]{1,12})?$')
 THEN RAISE EXCEPTION 'decimal string result required' USING ERRCODE='23514'; END IF;
 SELECT jsonb_build_object('accountMovements',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY "accountId",currency,"ledgerKind",date)
 FROM jsonb_to_recordset(payload->'accountMovements') a("accountId" uuid,currency text,"ledgerKind" text,date date,"nativeDelta" numeric,"bookDeltaInr" numeric,"cashDelta" numeric,"openingDelta" numeric,"unresolvedDelta" numeric,"postingCount" bigint,"incompleteEvidence" boolean)),'[]'::jsonb),
 'categoryMovements',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY "accountId",month,kind,"categoryId")
 FROM jsonb_to_recordset(payload->'categoryMovements') c("accountId" uuid,month date,kind text,"categoryId" uuid,"amountInr" numeric,"postingCount" bigint)),'[]'::jsonb)) INTO actual;
 expected:=ops.bank_expected_contributions(inputs);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'bank result does not reconcile to captured postings' USING ERRCODE='23514'; END IF;
 IF pg_database_size(current_database())>=400000000 THEN RAISE EXCEPTION 'storage capacity required' USING ERRCODE='P0001'; END IF;
 INSERT INTO reporting.bank_account_movement(household_id,run_id,generation_id,account_id,currency,ledger_kind,effective_date,native_delta,book_delta_inr,cash_delta,opening_delta,unresolved_delta,posting_count,incomplete_evidence)
 SELECT household,target,candidate.generation_id,"accountId",currency,"ledgerKind",date,"nativeDelta","bookDeltaInr","cashDelta","openingDelta","unresolvedDelta","postingCount","incompleteEvidence"
 FROM jsonb_to_recordset(actual->'accountMovements') a("accountId" uuid,currency text,"ledgerKind" text,date date,"nativeDelta" numeric,"bookDeltaInr" numeric,"cashDelta" numeric,"openingDelta" numeric,"unresolvedDelta" numeric,"postingCount" bigint,"incompleteEvidence" boolean)
 ON CONFLICT(run_id,account_id,currency,ledger_kind,effective_date) DO UPDATE SET
 native_delta=bank_account_movement.native_delta+excluded.native_delta,book_delta_inr=bank_account_movement.book_delta_inr+excluded.book_delta_inr,
 cash_delta=bank_account_movement.cash_delta+excluded.cash_delta,opening_delta=bank_account_movement.opening_delta+excluded.opening_delta,
 unresolved_delta=bank_account_movement.unresolved_delta+excluded.unresolved_delta,posting_count=bank_account_movement.posting_count+excluded.posting_count,
 incomplete_evidence=bank_account_movement.incomplete_evidence OR excluded.incomplete_evidence;
 INSERT INTO reporting.bank_category_movement(household_id,run_id,generation_id,account_id,month,kind,category_id,amount_inr,posting_count)
 SELECT household,target,candidate.generation_id,"accountId",month,kind,"categoryId","amountInr","postingCount"
 FROM jsonb_to_recordset(actual->'categoryMovements') c("accountId" uuid,month date,kind text,"categoryId" uuid,"amountInr" numeric,"postingCount" bigint)
 ON CONFLICT ON CONSTRAINT bank_category_grain DO UPDATE SET amount_inr=bank_category_movement.amount_inr+excluded.amount_inr,
 posting_count=bank_category_movement.posting_count+excluded.posting_count;
 more:=(inputs->>'hasMore')::boolean;
 UPDATE ops.bank_candidate SET page=page+1,event_count=event_count+jsonb_array_length(inputs->'events'),
 cursor_date=coalesce((inputs->'lastCursor'->>'date')::date,cursor_date),cursor_id=coalesce((inputs->'lastCursor'->>'eventId')::uuid,cursor_id),
 state=CASE WHEN more THEN 'building' ELSE 'calculated' END WHERE run_id=target RETURNING * INTO candidate;
 UPDATE ops.calculation_budget SET lease_token=NULL,lease_until=NULL,
 state=CASE WHEN window_attempts>=100 AND more THEN 'paused' ELSE 'ready' END,
 reason=CASE WHEN window_attempts>=100 AND more THEN 'window_limit' ELSE NULL END WHERE run_id=target;
 RETURN NEXT candidate;
END $$;
REVOKE ALL ON FUNCTION ops.commit_bank_page(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.commit_bank_page(uuid,uuid,uuid,jsonb) TO networth_worker;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops.resume_calculation_budget(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; budget ops.calculation_budget; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target FOR UPDATE;
 IF NOT FOUND OR core.member_role(candidate.household_id) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF budget.state<>'paused' OR NOT (candidate.state='planning' OR EXISTS(SELECT FROM ops.bank_candidate WHERE run_id=target AND state='building')) THEN RAISE EXCEPTION 'calculation is not resumable' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp() AND remaining_attempts>=1 AND remaining_storage_bytes>=819200)
 OR pg_database_size(current_database())+819200>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 UPDATE ops.calculation_budget SET state='ready',reason=NULL,window_number=window_number+1,window_attempts=0,
 step_page=candidate.page,step_attempts=0,lease_token=NULL,lease_until=NULL WHERE run_id=target;
END $$;

UPDATE core.system_installation SET schema_version=7;
