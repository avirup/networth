-- Only a trusted capacity verifier may create/renew a lease. Phase 6 supplies it.
-- Permits must cover worst-case workflow attempts across every provider meter,
-- including other projects sharing the account, before the 80% pause threshold.
CREATE TABLE ops.import_admission (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 verified_until timestamptz NOT NULL,
 workflow_verified boolean NOT NULL DEFAULT false,
 remaining_imports integer NOT NULL CHECK(remaining_imports>=0),
 remaining_storage_bytes bigint NOT NULL CHECK(remaining_storage_bytes>=0),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500)
);
REVOKE ALL ON ops.import_admission FROM PUBLIC,networth_auth,networth_member,networth_worker;
GRANT SELECT ON ops.import_admission TO networth_member;
CREATE FUNCTION ops.reserve_import(bytes integer, evidence_rows integer, target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE estimate bigint; BEGIN
 IF core.member_role(target) NOT IN ('owner','editor') OR core.member_role(target) IS NULL THEN RAISE EXCEPTION 'import forbidden' USING ERRCODE='42501'; END IF;
 IF bytes NOT BETWEEN 1 AND 3000000 OR evidence_rows NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'import envelope exceeded' USING ERRCODE='23514'; END IF;
 -- Reserve input/index growth and candidate rebuild space conservatively, atomically.
 estimate := bytes::bigint*16 + evidence_rows::bigint*8192;
 UPDATE ops.import_admission SET remaining_imports=remaining_imports-1,remaining_storage_bytes=remaining_storage_bytes-estimate
 WHERE singleton AND workflow_verified AND verified_until>clock_timestamp()
   AND remaining_imports>0 AND remaining_storage_bytes>=estimate
   AND pg_database_size(current_database())+estimate<=400000000;
 IF NOT FOUND THEN RAISE EXCEPTION 'confirmation paused: verified workflow and capacity required' USING ERRCODE='P0001'; END IF;
END $$;
REVOKE ALL ON FUNCTION ops.reserve_import(integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.reserve_import(integer,integer,uuid) TO networth_member;
CREATE FUNCTION ops.guard_import_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_user='networth_member' THEN PERFORM ops.reserve_import(NEW.request_bytes,NEW.row_count,NEW.household_id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ops.guard_import_admission() FROM PUBLIC;
CREATE TRIGGER import_admission BEFORE INSERT ON core.import_batch FOR EACH ROW EXECUTE FUNCTION ops.guard_import_admission();
CREATE INDEX source_provider_reference ON core.source_record(household_id,provider_reference) WHERE provider_reference IS NOT NULL;
UPDATE core.system_installation SET schema_version=3;
