-- Delivery bookkeeping is separate from immutable outbox intent. Receipt is not publication.
CREATE TABLE ops.workflow_delivery (
 outbox_id uuid PRIMARY KEY,
 household_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','received','paused')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 total_attempts integer NOT NULL DEFAULT 0 CHECK(total_attempts>=attempts),
 lease_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 received_at timestamptz,
 last_error text CHECK(last_error IN ('send_failed','attempt_limit')),
 FOREIGN KEY(household_id,outbox_id) REFERENCES ops.outbox_event(household_id,id),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX workflow_delivery_pending ON ops.workflow_delivery(next_attempt_at,outbox_id) WHERE state IN ('pending','sending');
ALTER TABLE ops.workflow_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.workflow_delivery FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 EXECUTE format('CREATE POLICY workflow_delivery_admin ON ops.workflow_delivery TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
CREATE POLICY workflow_delivery_member ON ops.workflow_delivery FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL);
REVOKE ALL ON ops.workflow_delivery FROM PUBLIC,networth_auth,networth_member,networth_worker;
GRANT SELECT ON ops.workflow_delivery TO networth_member;
GRANT USAGE ON SCHEMA ops TO networth_worker;
CREATE FUNCTION ops.seed_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$ BEGIN
 INSERT INTO ops.workflow_delivery(outbox_id,household_id) VALUES(NEW.id,NEW.household_id);
 RETURN NEW;
END $$;
CREATE TRIGGER seed_delivery AFTER INSERT ON ops.outbox_event FOR EACH ROW EXECUTE FUNCTION ops.seed_delivery();
INSERT INTO ops.workflow_delivery(outbox_id,household_id) SELECT id,household_id FROM ops.outbox_event;
--> statement-breakpoint
-- Claims commit before network I/O. A crashed sender cannot lose its attempt counter.
CREATE FUNCTION ops.claim_deliveries(maximum integer, target uuid DEFAULT NULL)
RETURNS TABLE(outbox_id uuid,household_id uuid,batch_id uuid,revision integer,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$ BEGIN
 IF maximum IS NULL OR maximum NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'invalid dispatch bound' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp())
 OR pg_database_size(current_database())>=400000000 THEN RETURN; END IF;
 -- Expired third claims pause rather than being retried forever after a process crash.
 UPDATE ops.workflow_delivery d SET state='paused',lease_token=NULL,lease_until=NULL,last_error='attempt_limit'
 WHERE d.outbox_id IN (SELECT p.outbox_id FROM ops.workflow_delivery p WHERE p.state IN ('pending','sending') AND (p.attempts>=3 OR p.total_attempts>=100) AND (p.lease_until IS NULL OR p.lease_until<=clock_timestamp()) AND (target IS NULL OR p.household_id=target) ORDER BY p.outbox_id LIMIT 5 FOR UPDATE SKIP LOCKED);
 RETURN QUERY WITH candidates AS (
  SELECT d.outbox_id FROM ops.workflow_delivery d
  WHERE d.state IN ('pending','sending') AND d.attempts<3 AND d.total_attempts<100
   AND d.next_attempt_at<=clock_timestamp() AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp())
   AND (target IS NULL OR d.household_id=target)
  ORDER BY d.next_attempt_at,d.outbox_id LIMIT maximum FOR UPDATE SKIP LOCKED
 ), claimed AS (
  UPDATE ops.workflow_delivery d SET state='sending',attempts=d.attempts+1,total_attempts=d.total_attempts+1,
   lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds',last_error=NULL
  FROM candidates c WHERE c.outbox_id=d.outbox_id RETURNING d.*
 ) SELECT c.outbox_id,c.household_id,o.batch_id,o.revision,c.lease_token FROM claimed c JOIN ops.outbox_event o ON o.id=c.outbox_id AND o.household_id=c.household_id;
END $$;
CREATE FUNCTION ops.finish_delivery(target uuid, token uuid, succeeded boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$
DECLARE updated integer; BEGIN
 UPDATE ops.workflow_delivery SET state=CASE WHEN succeeded THEN 'sent' WHEN attempts>=3 THEN 'paused' ELSE 'pending' END,
 lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '1 minute',
 sent_at=CASE WHEN succeeded THEN clock_timestamp() ELSE sent_at END,
 last_error=CASE WHEN succeeded THEN NULL WHEN attempts>=3 THEN 'attempt_limit' ELSE 'send_failed' END
 WHERE outbox_id=target AND lease_token=token AND state='sending';
 GET DIAGNOSTICS updated=ROW_COUNT;
 IF updated=1 AND succeeded THEN UPDATE ops.outbox_event SET state='dispatched' WHERE id=target; END IF;
 RETURN updated=1;
END $$;
CREATE FUNCTION ops.accept_delivery(target uuid, household uuid, batch uuid, input_revision integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM ops.outbox_event WHERE id=target AND household_id=household AND batch_id=batch AND revision=input_revision) THEN RAISE EXCEPTION 'unknown work intent' USING ERRCODE='23514'; END IF;
 UPDATE ops.workflow_delivery SET state='received',received_at=coalesce(received_at,clock_timestamp()),lease_token=NULL,lease_until=NULL,last_error=NULL
 WHERE outbox_id=target AND state<>'received';
 UPDATE ops.outbox_event SET state='dispatched' WHERE id=target AND state<>'dispatched';
END $$;
REVOKE ALL ON FUNCTION ops.seed_delivery(),ops.claim_deliveries(integer,uuid),ops.finish_delivery(uuid,uuid,boolean),ops.accept_delivery(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_deliveries(integer,uuid),ops.finish_delivery(uuid,uuid,boolean),ops.accept_delivery(uuid,uuid,uuid,integer) TO networth_worker;
--> statement-breakpoint
-- Explicit manual resume is owner-only, with fresh admission and preserved cumulative usage.
CREATE FUNCTION ops.resume_delivery(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE household uuid; BEGIN
 SELECT household_id INTO household FROM ops.workflow_delivery WHERE outbox_id=target;
 IF household IS NULL OR core.member_role(household) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM ops.import_admission WHERE singleton AND workflow_verified AND verified_until>clock_timestamp()) THEN RAISE EXCEPTION 'capacity verification required' USING ERRCODE='P0001'; END IF;
 UPDATE ops.workflow_delivery SET state='pending',attempts=0,last_error=NULL,next_attempt_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
 WHERE outbox_id=target AND state='paused' AND total_attempts<100;
 IF NOT FOUND THEN RAISE EXCEPTION 'delivery is not resumable' USING ERRCODE='P0001'; END IF;
END $$;
REVOKE ALL ON FUNCTION ops.resume_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.resume_delivery(uuid) TO networth_member;
UPDATE core.system_installation SET schema_version=4;
