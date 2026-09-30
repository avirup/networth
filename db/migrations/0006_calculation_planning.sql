-- A late batch must never insert a rebuild request below a captured high-watermark.
DO $$ BEGIN
 IF EXISTS(SELECT FROM ops.rebuild_request r JOIN core.import_batch b ON b.household_id=r.household_id AND b.id=r.batch_id WHERE r.revision<>b.revision)
 THEN RAISE EXCEPTION 'rebuild revision mismatch requires administrator review' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION ops.guard_rebuild_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,core,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM core.import_batch WHERE household_id=NEW.household_id AND id=NEW.batch_id AND revision=NEW.revision)
 THEN RAISE EXCEPTION 'rebuild revision must match its batch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ops.guard_rebuild_revision() FROM PUBLIC;
CREATE TRIGGER rebuild_revision BEFORE INSERT ON ops.rebuild_request FOR EACH ROW EXECUTE FUNCTION ops.guard_rebuild_revision();
--> statement-breakpoint
-- A candidate fixes its input revision before any bounded planning work starts.
CREATE TABLE ops.calculation_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id uuid NOT NULL REFERENCES core.household(id),
 source_revision integer NOT NULL CHECK(source_revision>0),
 rule_version text NOT NULL CHECK(rule_version='bank-plan-v1'),
 state text NOT NULL DEFAULT 'planning' CHECK(state IN ('planning','prepared')),
 page integer NOT NULL DEFAULT 0 CHECK(page>=0),
 cursor_revision integer NOT NULL DEFAULT 0 CHECK(cursor_revision>=0 AND cursor_revision<=source_revision),
 cursor_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT calculation_run_scope UNIQUE(household_id,id),
 CONSTRAINT calculation_run_household UNIQUE(household_id)
);
CREATE TABLE ops.calculation_account (
 household_id uuid NOT NULL,
 run_id uuid NOT NULL,
 account_id uuid NOT NULL,
 earliest_date date NOT NULL,
 PRIMARY KEY(run_id,account_id),
 FOREIGN KEY(household_id,run_id) REFERENCES ops.calculation_run(household_id,id),
 FOREIGN KEY(household_id,account_id) REFERENCES core.dim_account(household_id,id)
);
CREATE INDEX rebuild_planning_cursor ON ops.rebuild_request(household_id,revision,id);
ALTER TABLE ops.calculation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.calculation_run FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.calculation_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.calculation_account FORCE ROW LEVEL SECURITY;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['calculation_run','calculation_account'] LOOP
 EXECUTE format('CREATE POLICY %I ON ops.%I TO %I USING(true) WITH CHECK(true)',tab||'_admin',tab,current_user);
 EXECUTE format('CREATE POLICY %I ON ops.%I FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL)',tab||'_member',tab);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,networth_auth,networth_member,networth_worker',tab);
 EXECUTE format('GRANT SELECT ON ops.%I TO networth_member',tab);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION ops.begin_calculation_plan(target uuid, household uuid, batch uuid, input_revision integer)
RETURNS SETOF ops.calculation_run LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE watermark integer; existing ops.calculation_run; BEGIN
 IF NOT EXISTS(SELECT FROM ops.outbox_event o JOIN ops.workflow_delivery d ON d.outbox_id=o.id AND d.household_id=o.household_id
  WHERE o.id=target AND o.household_id=household AND o.batch_id=batch AND o.revision=input_revision AND d.state='received')
 THEN RAISE EXCEPTION 'received work intent required' USING ERRCODE='23514'; END IF;
 -- The import path uses the same row lock. Later imports get strictly later revisions.
 SELECT revision INTO watermark FROM ops.source_revision WHERE household_id=household FOR UPDATE;
 SELECT * INTO existing FROM ops.calculation_run WHERE household_id=household;
 IF FOUND THEN RETURN NEXT existing; RETURN; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 RETURN QUERY INSERT INTO ops.calculation_run(household_id,source_revision,rule_version)
 VALUES(household,watermark,'bank-plan-v1') RETURNING *;
END $$;
-- Each page reads at most 100 immutable rebuild requests, coalescing across pages.
-- expected_page makes a lost response safe to retry, including concurrent retries.
CREATE FUNCTION ops.advance_calculation_plan(target uuid, household uuid, expected_page integer)
RETURNS SETOF ops.calculation_run LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; last_revision integer; last_id uuid; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND OR expected_page IS NULL OR expected_page<0 OR expected_page>candidate.page
 THEN RAISE EXCEPTION 'invalid planning checkpoint' USING ERRCODE='23514'; END IF;
 IF expected_page<candidate.page OR candidate.state='prepared' THEN RETURN NEXT candidate; RETURN; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 WITH page_rows AS MATERIALIZED (
  SELECT r.* FROM ops.rebuild_request r WHERE r.household_id=household AND r.revision<=candidate.source_revision
   AND (r.revision,r.id)>(candidate.cursor_revision,candidate.cursor_id)
  ORDER BY r.revision,r.id LIMIT 100
 ), merged AS (
  INSERT INTO ops.calculation_account(household_id,run_id,account_id,earliest_date)
  SELECT household,target,account_id,min(earliest_date) FROM page_rows GROUP BY account_id
  ON CONFLICT(run_id,account_id) DO UPDATE SET earliest_date=least(calculation_account.earliest_date,excluded.earliest_date)
 ) SELECT revision,id INTO last_revision,last_id FROM page_rows ORDER BY revision DESC,id DESC LIMIT 1;
 UPDATE ops.calculation_run SET page=page+1,cursor_revision=coalesce(last_revision,cursor_revision),
 cursor_id=coalesce(last_id,cursor_id),updated_at=clock_timestamp(),
 state=CASE WHEN NOT EXISTS(SELECT FROM ops.rebuild_request r WHERE r.household_id=household AND r.revision<=candidate.source_revision
  AND (r.revision,r.id)>(coalesce(last_revision,candidate.cursor_revision),coalesce(last_id,candidate.cursor_id))) THEN 'prepared' ELSE 'planning' END
 WHERE id=target RETURNING * INTO candidate;
 RETURN NEXT candidate;
END $$;
REVOKE ALL ON FUNCTION ops.begin_calculation_plan(uuid,uuid,uuid,integer),ops.advance_calculation_plan(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.begin_calculation_plan(uuid,uuid,uuid,integer),ops.advance_calculation_plan(uuid,uuid,integer) TO networth_worker;
UPDATE core.system_installation SET schema_version=5;
