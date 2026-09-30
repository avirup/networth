CREATE TABLE "ops"."current_report_release" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."report_release_account" (
	"household_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	CONSTRAINT "report_release_account_release_id_account_id_pk" PRIMARY KEY("release_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "ops"."report_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"as_of" date NOT NULL,
	"state" text DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "report_release_scope" UNIQUE("household_id","id"),
	CONSTRAINT "report_release_run" UNIQUE("run_id"),
	CONSTRAINT "report_release_revision_check" CHECK ("ops"."report_release"."source_revision">0),
	CONSTRAINT "report_release_state_check" CHECK ("ops"."report_release"."state" in ('published','previous','retired'))
);
--> statement-breakpoint
CREATE TABLE "ops"."report_request_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."current_report_release" ADD CONSTRAINT "current_report_release_household_id_release_id_report_release_household_id_id_fk" FOREIGN KEY ("household_id","release_id") REFERENCES "ops"."report_release"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_release_account" ADD CONSTRAINT "report_release_account_household_id_release_id_report_release_household_id_id_fk" FOREIGN KEY ("household_id","release_id") REFERENCES "ops"."report_release"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_release_account" ADD CONSTRAINT "report_release_account_household_id_source_run_id_generation_id_bank_candidate_household_id_run_id_generation_id_fk" FOREIGN KEY ("household_id","source_run_id","generation_id") REFERENCES "ops"."bank_candidate"("household_id","run_id","generation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_release_account" ADD CONSTRAINT "report_release_account_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_release" ADD CONSTRAINT "report_release_household_id_run_id_calculation_run_household_id_id_fk" FOREIGN KEY ("household_id","run_id") REFERENCES "ops"."calculation_run"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."report_request_pin" ADD CONSTRAINT "report_request_pin_household_id_release_id_report_release_household_id_id_fk" FOREIGN KEY ("household_id","release_id") REFERENCES "ops"."report_release"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_pin_expiry" ON "ops"."report_request_pin" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE ops.calculation_run DROP CONSTRAINT calculation_run_household;
ALTER TABLE ops.calculation_run DROP CONSTRAINT calculation_run_state_check;
ALTER TABLE ops.calculation_run ADD CONSTRAINT calculation_run_state_check CHECK(state IN ('planning','prepared','superseded'));
CREATE INDEX calculation_run_household_revision ON ops.calculation_run(household_id,source_revision DESC);
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['report_release','report_release_account','current_report_release','report_request_pin'] LOOP
  EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE ops.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON ops.%I TO %I USING(true) WITH CHECK(true)',tab||'_admin',tab,current_user);
  EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,networth_auth,networth_member,networth_worker',tab);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION ops.publish_bank_release(target uuid, household uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,core,pg_temp AS $$
DECLARE run ops.calculation_run; bank ops.bank_candidate; balances ops.bank_balance_candidate; current_id uuid; prior_previous uuid; new_release uuid; BEGIN
 SELECT * INTO run FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT bank FROM ops.bank_candidate WHERE run_id=target;
 SELECT * INTO STRICT balances FROM ops.bank_balance_candidate WHERE run_id=target;
 IF bank.state<>'calculated' OR balances.state<>'calculated' OR run.state<>'prepared' THEN RAISE EXCEPTION 'complete bank candidate required' USING ERRCODE='23514'; END IF;
 IF run.source_revision IS DISTINCT FROM (SELECT revision FROM ops.source_revision WHERE household_id=household FOR UPDATE)
 THEN UPDATE ops.calculation_run SET state='superseded',updated_at=clock_timestamp() WHERE id=target; RETURN NULL; END IF;
 SELECT release_id INTO current_id FROM ops.current_report_release WHERE household_id=household FOR UPDATE;
 IF EXISTS(SELECT FROM ops.report_release WHERE run_id=target) THEN RETURN (SELECT id FROM ops.report_release WHERE run_id=target); END IF;
 -- Every bank/cash account with captured evidence must be supplied by this candidate or the current complete manifest.
 IF EXISTS(
  SELECT a.id FROM core.dim_account a WHERE a.household_id=household AND a.kind IN ('bank','cash')
   AND EXISTS(SELECT FROM core.import_batch b WHERE b.household_id=household AND b.account_id=a.id AND b.revision<=run.source_revision)
   AND NOT EXISTS(SELECT FROM reporting.bank_balance_checkpoint c WHERE c.run_id=target AND c.account_id=a.id AND c.effective_date=bank.as_of)
   AND NOT EXISTS(SELECT FROM ops.report_release_account m WHERE m.release_id=current_id AND m.household_id=household AND m.account_id=a.id)
 ) THEN RAISE EXCEPTION 'complete account manifest required' USING ERRCODE='23514'; END IF;
 SELECT id INTO prior_previous FROM ops.report_release WHERE household_id=household AND state='previous' ORDER BY published_at DESC LIMIT 1;
 IF prior_previous IS NOT NULL AND NOT EXISTS(SELECT FROM ops.report_request_pin WHERE release_id=prior_previous AND expires_at>clock_timestamp()) THEN
  DELETE FROM ops.report_request_pin WHERE release_id=prior_previous;
  DELETE FROM ops.report_release_account WHERE release_id=prior_previous;
  DELETE FROM ops.report_release WHERE id=prior_previous;
 END IF;
 INSERT INTO ops.report_release(household_id,run_id,source_revision,as_of) VALUES(household,target,run.source_revision,bank.as_of) RETURNING id INTO new_release;
 IF current_id IS NOT NULL THEN
  INSERT INTO ops.report_release_account(household_id,release_id,account_id,source_run_id,generation_id,effective_date)
  SELECT household,new_release,m.account_id,m.source_run_id,m.generation_id,m.effective_date FROM ops.report_release_account m
   WHERE m.release_id=current_id AND m.household_id=household
   AND NOT EXISTS(SELECT FROM reporting.bank_balance_checkpoint c WHERE c.run_id=target AND c.account_id=m.account_id AND c.effective_date=bank.as_of);
 END IF;
 INSERT INTO ops.report_release_account(household_id,release_id,account_id,source_run_id,generation_id,effective_date)
 SELECT household,new_release,c.account_id,target,c.generation_id,c.effective_date FROM reporting.bank_balance_checkpoint c WHERE c.run_id=target
 AND EXISTS(SELECT FROM core.import_batch b WHERE b.household_id=household AND b.account_id=c.account_id AND b.revision<=run.source_revision);
 IF (SELECT count(*) FROM ops.report_release_account m WHERE m.release_id=new_release)<>(
  SELECT count(*) FROM core.dim_account a WHERE a.household_id=household AND a.kind IN ('bank','cash')
   AND EXISTS(SELECT FROM core.import_batch b WHERE b.household_id=household AND b.account_id=a.id AND b.revision<=run.source_revision))
 THEN RAISE EXCEPTION 'release manifest is incomplete' USING ERRCODE='23514'; END IF;
 IF current_id IS NOT NULL THEN UPDATE ops.report_release SET state='previous' WHERE id=current_id; END IF;
 INSERT INTO ops.current_report_release(household_id,release_id) VALUES(household,new_release)
 ON CONFLICT(household_id) DO UPDATE SET release_id=excluded.release_id,updated_at=clock_timestamp();
 RETURN new_release;
END $$;
CREATE FUNCTION ops.pin_current_report(household uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE release uuid; BEGIN
 IF core.member_role(household) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT release_id INTO release FROM ops.current_report_release WHERE household_id=household;
 IF release IS NULL THEN RETURN NULL; END IF;
 INSERT INTO ops.report_request_pin(household_id,release_id,expires_at) VALUES(household,release,clock_timestamp()+interval '15 minutes');
 RETURN release;
END $$;
CREATE FUNCTION ops.cleanup_derived_reports() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,pg_temp AS $$
DECLARE changed integer:=0; old_id uuid; stale_run uuid; BEGIN
 DELETE FROM ops.report_request_pin WHERE expires_at<=clock_timestamp();
 FOR old_id IN SELECT id FROM ops.report_release r WHERE state='previous' AND published_at<clock_timestamp()-interval '24 hours'
  AND NOT EXISTS(SELECT FROM ops.report_request_pin p WHERE p.release_id=r.id AND p.expires_at>clock_timestamp())
 LOOP
  DELETE FROM ops.report_release_account WHERE release_id=old_id;
 DELETE FROM ops.report_release WHERE id=old_id; changed:=changed+1;
 END LOOP;
 FOR stale_run IN SELECT r.id FROM ops.calculation_run r WHERE r.updated_at<clock_timestamp()-interval '24 hours'
  AND (r.state='superseded' OR NOT EXISTS(SELECT FROM ops.report_release release WHERE release.run_id=r.id))
  AND NOT EXISTS(SELECT FROM ops.report_release_account m WHERE m.source_run_id=r.id)
 LOOP
  DELETE FROM reporting.bank_balance_checkpoint WHERE run_id=stale_run;
  DELETE FROM reporting.bank_category_movement WHERE run_id=stale_run;
  DELETE FROM reporting.bank_account_movement WHERE run_id=stale_run;
  DELETE FROM ops.bank_balance_candidate WHERE run_id=stale_run;
  DELETE FROM ops.bank_candidate WHERE run_id=stale_run;
  DELETE FROM ops.calculation_account WHERE run_id=stale_run;
  DELETE FROM ops.calculation_budget WHERE run_id=stale_run;
  DELETE FROM ops.calculation_run WHERE id=stale_run;
  changed:=changed+1;
 END LOOP;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION ops.publish_bank_release(uuid,uuid),ops.pin_current_report(uuid),ops.cleanup_derived_reports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.publish_bank_release(uuid,uuid),ops.cleanup_derived_reports() TO networth_worker;
GRANT EXECUTE ON FUNCTION ops.pin_current_report(uuid) TO networth_member;
--> statement-breakpoint
CREATE FUNCTION reporting.bank_overview(household uuid, release uuid, selected_month date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,reporting,core,pg_temp AS $$
DECLARE payload jsonb; BEGIN
 IF core.member_role(household) IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM ops.report_release r WHERE r.id=release AND r.household_id=household AND r.state IN ('published','previous'))
 THEN RAISE EXCEPTION 'report release unavailable' USING ERRCODE='P0001'; END IF;
 WITH meta AS (SELECT * FROM ops.report_release WHERE id=release), accounts AS (
  SELECT a.id,a.name,a.currency,c.calculated_balance,c.reconciled_balance,c.result,m.effective_date
  FROM ops.report_release_account m JOIN core.dim_account a ON a.id=m.account_id AND a.household_id=m.household_id
  JOIN reporting.bank_balance_checkpoint c ON c.run_id=m.source_run_id AND c.generation_id=m.generation_id AND c.account_id=m.account_id AND c.effective_date=m.effective_date
  WHERE m.release_id=release AND m.household_id=household
 ), categories AS (
  SELECT c.kind,coalesce(d.name,'Uncategorized') category,sum(c.amount_inr) amount,sum(c.posting_count) count
  FROM ops.report_release_account m JOIN reporting.bank_category_movement c ON c.run_id=m.source_run_id AND c.generation_id=m.generation_id AND c.account_id=m.account_id
  LEFT JOIN core.dim_category d ON d.id=c.category_id AND d.household_id=c.household_id
  WHERE m.release_id=release AND m.household_id=household AND c.month=date_trunc('month',selected_month)::date GROUP BY c.kind,coalesce(d.name,'Uncategorized')
 ) SELECT jsonb_build_object('release',jsonb_build_object('id',meta.id,'asOf',meta.as_of,'sourceRevision',meta.source_revision,'publishedAt',meta.published_at),
  'summary',jsonb_build_object('knownAssetsInr',coalesce((SELECT sum(reconciled_balance) FROM accounts WHERE currency='INR'),0)::text,
   'netWorthInr',coalesce((SELECT sum(reconciled_balance) FROM accounts WHERE currency='INR'),0)::text,
   'monthlyIncomeInr',coalesce((SELECT sum(amount) FROM categories WHERE kind='income'),0)::text,
   'monthlyExpenseInr',coalesce((SELECT sum(amount) FROM categories WHERE kind='expense'),0)::text,
   'unknownAccountCount',(SELECT count(*) FROM accounts WHERE currency<>'INR' OR reconciled_balance IS NULL)),
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'currency',currency,'effectiveDate',effective_date,
   'calculatedBalance',calculated_balance::text,'reconciledBalance',reconciled_balance::text,'status',result->>'status','reasons',result->'reasons') ORDER BY name,id) FROM accounts),'[]'::jsonb),
  'categories',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'category',category,'amountInr',amount::text,'postingCount',count) ORDER BY kind,amount DESC,category) FROM categories),'[]'::jsonb))
 INTO payload FROM meta;
 IF octet_length(payload::text)>3000000 THEN RAISE EXCEPTION 'report response exceeds budget' USING ERRCODE='54000'; END IF;
 RETURN payload;
END $$;
REVOKE ALL ON FUNCTION reporting.bank_overview(uuid,uuid,date) FROM PUBLIC;
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
GRANT USAGE ON SCHEMA reporting TO networth_member;
GRANT EXECUTE ON FUNCTION reporting.bank_overview(uuid,uuid,date) TO networth_member;
UPDATE core.system_installation SET schema_version=9;
CREATE POLICY report_release_member ON ops.report_release FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
CREATE POLICY report_release_account_member ON ops.report_release_account FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
CREATE POLICY current_report_release_member ON ops.current_report_release FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
GRANT SELECT ON ops.report_release,ops.report_release_account,ops.current_report_release TO networth_member;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops.begin_calculation_plan(target uuid, household uuid, batch uuid, input_revision integer)
RETURNS SETOF ops.calculation_run LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE watermark integer; existing ops.calculation_run; published_revision integer; BEGIN
 IF NOT EXISTS(SELECT FROM ops.outbox_event o JOIN ops.workflow_delivery d ON d.outbox_id=o.id AND d.household_id=o.household_id
  WHERE o.id=target AND o.household_id=household AND o.batch_id=batch AND o.revision=input_revision AND d.state='received')
 THEN RAISE EXCEPTION 'received work intent required' USING ERRCODE='23514'; END IF;
 SELECT revision INTO watermark FROM ops.source_revision WHERE household_id=household FOR UPDATE;
 SELECT r.source_revision INTO published_revision FROM ops.current_report_release c JOIN ops.report_release r ON r.id=c.release_id AND r.household_id=c.household_id WHERE c.household_id=household;
 SELECT * INTO existing FROM ops.calculation_run r WHERE r.household_id=household AND r.state<>'superseded'
  AND NOT EXISTS(SELECT FROM ops.report_release release WHERE release.run_id=r.id) ORDER BY r.created_at DESC LIMIT 1;
 IF FOUND THEN RETURN NEXT existing; RETURN; END IF;
 IF published_revision IS NOT NULL AND watermark<=published_revision THEN
  SELECT r.* INTO existing FROM ops.calculation_run r JOIN ops.report_release release ON release.run_id=r.id
   WHERE r.household_id=household ORDER BY release.published_at DESC LIMIT 1;
  RETURN NEXT existing; RETURN;
 END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 RETURN QUERY INSERT INTO ops.calculation_run(household_id,source_revision,rule_version) VALUES(household,watermark,'bank-plan-v1') RETURNING *;
END $$;
--> statement-breakpoint
CREATE FUNCTION ops.calculation_workflow_snapshot(target uuid, household uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE result jsonb; BEGIN
 SELECT jsonb_build_object(
  'plan',to_jsonb(r),
  'asOf',(SELECT max(b.coverage_end)::text FROM core.import_batch b WHERE b.household_id=household AND b.revision<=r.source_revision),
  'bank',(SELECT to_jsonb(c) FROM ops.bank_candidate c WHERE c.run_id=target),
  'balance',(SELECT to_jsonb(c) FROM ops.bank_balance_candidate c WHERE c.run_id=target),
  'releaseId',(SELECT release.id FROM ops.report_release release WHERE release.run_id=target)
 ) INTO result FROM ops.calculation_run r WHERE r.id=target AND r.household_id=household;
 IF result IS NULL THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION ops.calculation_workflow_snapshot(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.calculation_workflow_snapshot(uuid,uuid) TO networth_worker;
CREATE FUNCTION ops.restore_calculation_pause(target uuid, pause_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target FOR UPDATE;
 IF NOT FOUND OR core.member_role(candidate.household_id) IS DISTINCT FROM 'owner' OR pause_reason NOT IN ('capacity','retry_limit','window_limit')
 THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 UPDATE ops.calculation_budget SET state='paused',reason=pause_reason
 WHERE run_id=target AND state='ready' AND lease_token IS NULL;
END $$;
REVOKE ALL ON FUNCTION ops.restore_calculation_pause(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.restore_calculation_pause(uuid,text) TO networth_member;
CREATE OR REPLACE FUNCTION ops.advance_calculation_plan_reserved(target uuid, household uuid, expected_page integer)
RETURNS SETOF ops.calculation_run LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; last_revision integer; last_id uuid; baseline integer; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND OR expected_page IS NULL OR expected_page<0 OR expected_page>candidate.page THEN RAISE EXCEPTION 'invalid planning checkpoint' USING ERRCODE='23514'; END IF;
 IF expected_page<candidate.page OR candidate.state='prepared' THEN RETURN NEXT candidate; RETURN; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(r.source_revision,0) INTO baseline FROM ops.current_report_release c JOIN ops.report_release r ON r.id=c.release_id AND r.household_id=c.household_id WHERE c.household_id=household;
 baseline:=coalesce(baseline,0);
 WITH page_rows AS MATERIALIZED (
  SELECT r.* FROM ops.rebuild_request r WHERE r.household_id=household AND r.revision>baseline AND r.revision<=candidate.source_revision
   AND (r.revision,r.id)>(candidate.cursor_revision,candidate.cursor_id) ORDER BY r.revision,r.id LIMIT 100
 ), merged AS (
  INSERT INTO ops.calculation_account(household_id,run_id,account_id,earliest_date)
  SELECT household,target,account_id,min(earliest_date) FROM page_rows GROUP BY account_id
  ON CONFLICT(run_id,account_id) DO UPDATE SET earliest_date=least(calculation_account.earliest_date,excluded.earliest_date)
 ) SELECT revision,id INTO last_revision,last_id FROM page_rows ORDER BY revision DESC,id DESC LIMIT 1;
 UPDATE ops.calculation_run SET page=page+1,cursor_revision=coalesce(last_revision,cursor_revision),cursor_id=coalesce(last_id,cursor_id),updated_at=clock_timestamp(),
  state=CASE WHEN NOT EXISTS(SELECT FROM ops.rebuild_request r WHERE r.household_id=household AND r.revision>baseline AND r.revision<=candidate.source_revision
   AND (r.revision,r.id)>(coalesce(last_revision,candidate.cursor_revision),coalesce(last_id,candidate.cursor_id))) THEN 'prepared' ELSE 'planning' END
 WHERE id=target RETURNING * INTO candidate;
 RETURN NEXT candidate;
END $$;
