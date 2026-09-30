-- Verifier-owned execution capacity starts absent. Configuration is not verification.
CREATE TABLE ops.execution_capacity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 verified_until timestamptz NOT NULL,
 remaining_attempts bigint NOT NULL CHECK(remaining_attempts>=0),
 remaining_storage_bytes bigint NOT NULL CHECK(remaining_storage_bytes>=0)
);
CREATE TABLE ops.calculation_budget (
 run_id uuid PRIMARY KEY,
 household_id uuid NOT NULL,
 window_number integer NOT NULL DEFAULT 1 CHECK(window_number>0),
 window_attempts integer NOT NULL DEFAULT 0 CHECK(window_attempts BETWEEN 0 AND 100),
 total_attempts bigint NOT NULL DEFAULT 0 CHECK(total_attempts>=window_attempts),
 step_page integer NOT NULL DEFAULT 0 CHECK(step_page>=0),
 step_attempts integer NOT NULL DEFAULT 0 CHECK(step_attempts BETWEEN 0 AND 4),
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','paused')),
 reason text CHECK(reason IN ('capacity','retry_limit','window_limit')),
 lease_token uuid,
 lease_until timestamptz,
 FOREIGN KEY(household_id,run_id) REFERENCES ops.calculation_run(household_id,id),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((state='paused')=(reason IS NOT NULL))
);
ALTER TABLE ops.execution_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.execution_capacity FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.calculation_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.calculation_budget FORCE ROW LEVEL SECURITY;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['execution_capacity','calculation_budget'] LOOP
 EXECUTE format('CREATE POLICY %I ON ops.%I TO %I USING(true) WITH CHECK(true)',tab||'_admin',tab,current_user);
 EXECUTE format('REVOKE ALL ON ops.%I FROM PUBLIC,networth_auth,networth_member,networth_worker',tab);
 END LOOP;
END $$;
CREATE POLICY calculation_budget_member ON ops.calculation_budget FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
GRANT SELECT ON ops.calculation_budget TO networth_member;
CREATE FUNCTION ops.seed_calculation_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$ BEGIN
 INSERT INTO ops.calculation_budget(run_id,household_id) VALUES(NEW.id,NEW.household_id); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ops.seed_calculation_budget() FROM PUBLIC;
CREATE TRIGGER seed_calculation_budget AFTER INSERT ON ops.calculation_run FOR EACH ROW EXECUTE FUNCTION ops.seed_calculation_budget();
INSERT INTO ops.calculation_budget(run_id,household_id) SELECT id,household_id FROM ops.calculation_run;
--> statement-breakpoint
-- Remove the worker's unreserved path. Only the fenced completion function may call it.
ALTER FUNCTION ops.advance_calculation_plan(uuid,uuid,integer) RENAME TO advance_calculation_plan_reserved;
REVOKE ALL ON FUNCTION ops.advance_calculation_plan_reserved(uuid,uuid,integer) FROM PUBLIC,networth_worker;
CREATE FUNCTION ops.claim_planning_attempt(target uuid, household uuid, expected_page integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; budget ops.calculation_budget; pause_reason text; token uuid; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND OR expected_page IS NULL OR expected_page<0 OR expected_page>candidate.page THEN RAISE EXCEPTION 'invalid planning checkpoint' USING ERRCODE='23514'; END IF;
 IF expected_page<candidate.page OR candidate.state='prepared' THEN RETURN jsonb_build_object('status','unchanged','plan',to_jsonb(candidate)); END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF budget.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('status','busy','plan',to_jsonb(candidate)); END IF;
 IF budget.state='paused' THEN RETURN jsonb_build_object('status','paused','reason',budget.reason,'plan',to_jsonb(candidate)); END IF;
 IF budget.step_page<>candidate.page THEN budget.step_attempts:=0; END IF;
 IF budget.window_attempts>=100 THEN pause_reason:='window_limit';
 ELSIF budget.step_attempts>=4 THEN pause_reason:='retry_limit';
 ELSIF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())+819200>=400000000 THEN pause_reason:='capacity';
 ELSE
  -- One conservative execution unit and 100 * 8192 bytes of projected planning growth.
  -- Never refund failed/expired attempts: the verifier reconciles actual provider usage.
  UPDATE ops.execution_capacity SET remaining_attempts=remaining_attempts-1,remaining_storage_bytes=remaining_storage_bytes-819200
   WHERE singleton AND verified_until>clock_timestamp() AND remaining_attempts>=1 AND remaining_storage_bytes>=819200;
  IF NOT FOUND THEN pause_reason:='capacity'; END IF;
 END IF;
 IF pause_reason IS NOT NULL THEN
  UPDATE ops.calculation_budget SET state='paused',reason=pause_reason,lease_token=NULL,lease_until=NULL WHERE run_id=target;
  RETURN jsonb_build_object('status','paused','reason',pause_reason,'plan',to_jsonb(candidate));
 END IF;
 token:=gen_random_uuid();
 UPDATE ops.calculation_budget SET window_attempts=window_attempts+1,total_attempts=total_attempts+1,
  step_page=candidate.page,step_attempts=budget.step_attempts+1,lease_token=token,lease_until=clock_timestamp()+interval '30 seconds'
  WHERE run_id=target;
 RETURN jsonb_build_object('status','claimed','token',token,'plan',to_jsonb(candidate));
END $$;
CREATE FUNCTION ops.finish_planning_attempt(target uuid, household uuid, token uuid)
RETURNS SETOF ops.calculation_run LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; budget ops.calculation_budget; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown calculation' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF token IS NULL OR budget.lease_token IS DISTINCT FROM token OR budget.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'expired planning claim' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp()) THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 SELECT * INTO candidate FROM ops.advance_calculation_plan_reserved(target,household,budget.step_page);
 UPDATE ops.calculation_budget SET lease_token=NULL,lease_until=NULL,
 state=CASE WHEN window_attempts>=100 AND candidate.state='planning' THEN 'paused' ELSE 'ready' END,
 reason=CASE WHEN window_attempts>=100 AND candidate.state='planning' THEN 'window_limit' ELSE NULL END WHERE run_id=target;
 RETURN NEXT candidate;
END $$;
CREATE FUNCTION ops.fail_planning_attempt(target uuid, household uuid, token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$
DECLARE changed integer; BEGIN
 -- Follow the run -> budget lock order used by claim, finish and resume.
 PERFORM 1 FROM ops.calculation_run WHERE id=target AND household_id=household FOR UPDATE;
 UPDATE ops.calculation_budget SET lease_token=NULL,lease_until=NULL,
 state=CASE WHEN step_attempts>=4 OR window_attempts>=100 THEN 'paused' ELSE 'ready' END,
 reason=CASE WHEN window_attempts>=100 THEN 'window_limit' WHEN step_attempts>=4 THEN 'retry_limit' ELSE NULL END
 WHERE run_id=target AND household_id=household AND lease_token=token;
 GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;
REVOKE ALL ON FUNCTION ops.claim_planning_attempt(uuid,uuid,integer),ops.finish_planning_attempt(uuid,uuid,uuid),ops.fail_planning_attempt(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_planning_attempt(uuid,uuid,integer),ops.finish_planning_attempt(uuid,uuid,uuid),ops.fail_planning_attempt(uuid,uuid,uuid) TO networth_worker;
--> statement-breakpoint
CREATE FUNCTION ops.resume_calculation_budget(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE candidate ops.calculation_run; budget ops.calculation_budget; BEGIN
 SELECT * INTO candidate FROM ops.calculation_run WHERE id=target FOR UPDATE;
 IF NOT FOUND OR core.member_role(candidate.household_id) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT budget FROM ops.calculation_budget WHERE run_id=target FOR UPDATE;
 IF budget.state<>'paused' OR candidate.state<>'planning' THEN RAISE EXCEPTION 'calculation is not resumable' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR NOT EXISTS(SELECT FROM ops.execution_capacity WHERE singleton AND verified_until>clock_timestamp() AND remaining_attempts>=1 AND remaining_storage_bytes>=819200)
 OR pg_database_size(current_database())+819200>=400000000 THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 UPDATE ops.calculation_budget SET state='ready',reason=NULL,window_number=window_number+1,window_attempts=0,
 step_page=candidate.page,step_attempts=0,lease_token=NULL,lease_until=NULL WHERE run_id=target;
END $$;
REVOKE ALL ON FUNCTION ops.resume_calculation_budget(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.resume_calculation_budget(uuid) TO networth_member;
UPDATE core.system_installation SET schema_version=6;
