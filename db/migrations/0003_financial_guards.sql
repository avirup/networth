-- NUMERIC without typmod plus guards rejects excess scale instead of rounding input.
ALTER TABLE core.fact_statement_observation ALTER COLUMN balance TYPE numeric;
ALTER TABLE core.reconciliation_result ALTER COLUMN calculated_balance TYPE numeric, ALTER COLUMN difference TYPE numeric;
ALTER TABLE core.ownership_interest ALTER COLUMN fraction TYPE numeric;
ALTER TABLE core.fact_statement_observation ADD CHECK (balance IS NULL OR scale(balance)<=12);
ALTER TABLE core.reconciliation_result ADD CHECK ((calculated_balance IS NULL OR (abs(calculated_balance)<1e26 AND scale(calculated_balance)<=12)) AND (difference IS NULL OR (abs(difference)<1e26 AND scale(difference)<=12)));
ALTER TABLE core.ownership_interest ADD CHECK (scale(fraction)<=18);
ALTER TABLE core.import_batch ADD COLUMN created_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
ALTER TABLE core.import_batch ADD CONSTRAINT batch_reviewer FOREIGN KEY(household_id,reviewed_by) REFERENCES core.household_membership(household_id,user_id);
ALTER TABLE core.transaction_event ADD CONSTRAINT reversal_scope FOREIGN KEY(household_id,reverses_id) REFERENCES core.transaction_event(household_id,id), ADD CONSTRAINT replacement_scope FOREIGN KEY(household_id,replaces_id) REFERENCES core.transaction_event(household_id,id);
ALTER TABLE core.transaction_event ADD CHECK (kind NOT IN ('opening_balance','unresolved_reconciliation') OR review_note IS NOT NULL);
ALTER TABLE core.fact_statement_observation ADD CHECK (balance IS NOT NULL OR unknown_reason IS NOT NULL);
ALTER TABLE core.reconciliation_result ADD CHECK (status='matched' OR explanation IS NOT NULL);
ALTER TABLE core.fact_posting ADD CHECK (book_amount_inr<>0);
ALTER TABLE core.transaction_event ADD CHECK ((kind='reversal')=(reverses_id IS NOT NULL) AND (reverses_id IS NULL OR reverses_id<>id) AND (replaces_id IS NULL OR replaces_id<>id));
--> statement-breakpoint
-- Explicit administrator policy is needed even for a non-superuser table owner.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE
    (schemaname='core' AND tablename IN ('dim_owner','dim_institution','dim_account','dim_instrument','holding','dim_category','dim_counterparty','ownership_allocation','ownership_interest','reporting_scope','scope_member','import_batch','source_record','transaction_event','event_source_link','ledger_account','fact_posting','fact_statement_observation','reconciliation_result')) OR schemaname='ops'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.schemaname,t.tablename);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',t.schemaname,t.tablename);
    EXECUTE format('CREATE POLICY financial_admin ON %I.%I TO %I USING(true) WITH CHECK(true)',t.schemaname,t.tablename,current_user);
    EXECUTE format('CREATE POLICY financial_read ON %I.%I FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL)',t.schemaname,t.tablename);
    EXECUTE format('CREATE POLICY financial_insert ON %I.%I FOR INSERT TO networth_member WITH CHECK(core.member_role(household_id) IN (''owner'',''editor''))',t.schemaname,t.tablename);
    EXECUTE format('CREATE POLICY financial_update ON %I.%I FOR UPDATE TO networth_member USING(core.member_role(household_id) IN (''owner'',''editor'')) WITH CHECK(core.member_role(household_id) IN (''owner'',''editor''))',t.schemaname,t.tablename);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I.%I TO networth_member',t.schemaname,t.tablename);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,networth_auth,networth_worker',t.schemaname,t.tablename);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO networth_member;
GRANT SELECT ON core.dim_currency,core.dim_date TO networth_member;
INSERT INTO core.dim_currency VALUES ('INR',2),('USD',2),('EUR',2),('GBP',2),('JPY',0);
--> statement-breakpoint
CREATE FUNCTION core.financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'confirmed financial evidence is append-only; reverse and replace' USING ERRCODE='23514';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['import_batch','source_record','event_source_link','fact_posting','fact_statement_observation','reconciliation_result'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.financial_immutable()',t);
  END LOOP;
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ops.rebuild_request FOR EACH ROW EXECUTE FUNCTION core.financial_immutable();
CREATE FUNCTION core.guard_financial_dimension() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME='dim_account' AND (to_jsonb(NEW)-ARRAY['name','masked_reference','opened_on','closed_on']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','masked_reference','opened_on','closed_on']) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='dim_category' AND (to_jsonb(NEW)-ARRAY['name','archived']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','archived']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'accounting identity is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_identity BEFORE UPDATE ON core.dim_account FOR EACH ROW EXECUTE FUNCTION core.guard_financial_dimension();
CREATE TRIGGER immutable_identity BEFORE UPDATE ON core.dim_category FOR EACH ROW EXECUTE FUNCTION core.guard_financial_dimension();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON core.ledger_account FOR EACH ROW EXECUTE FUNCTION core.financial_immutable();
--> statement-breakpoint
CREATE FUNCTION core.guard_batch_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.created_xid := pg_current_xact_id();
  IF current_user='networth_member' AND NEW.reviewed_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN RAISE EXCEPTION 'reviewer mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batch_insert BEFORE INSERT ON core.import_batch FOR EACH ROW EXECUTE FUNCTION core.guard_batch_insert();
CREATE FUNCTION core.require_current_batch() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE batch uuid; BEGIN
  IF TG_TABLE_NAME='outbox_event' THEN
    IF NEW.state<>'pending' THEN RAISE EXCEPTION 'new work must be pending' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_TABLE_NAME IN ('source_record','transaction_event','outbox_event','rebuild_request') THEN batch:=NEW.batch_id;
  ELSE SELECT batch_id INTO batch FROM core.source_record WHERE household_id=NEW.household_id AND id=NEW.source_id; END IF;
  IF NOT EXISTS(SELECT FROM core.import_batch WHERE household_id=NEW.household_id AND id=batch AND created_xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'evidence and work must be inserted in the batch transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER current_batch BEFORE INSERT ON core.source_record FOR EACH ROW EXECUTE FUNCTION core.require_current_batch();
CREATE TRIGGER current_batch BEFORE INSERT ON core.transaction_event FOR EACH ROW EXECUTE FUNCTION core.require_current_batch();
CREATE TRIGGER current_batch BEFORE INSERT ON core.fact_statement_observation FOR EACH ROW EXECUTE FUNCTION core.require_current_batch();
CREATE TRIGGER current_batch BEFORE INSERT ON core.event_source_link FOR EACH ROW EXECUTE FUNCTION core.require_current_batch();
CREATE TRIGGER current_batch BEFORE INSERT ON ops.outbox_event FOR EACH ROW EXECUTE FUNCTION core.require_current_batch();
CREATE TRIGGER current_batch BEFORE INSERT ON ops.rebuild_request FOR EACH ROW EXECUTE FUNCTION core.require_current_batch();
--> statement-breakpoint
CREATE FUNCTION core.guard_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.state='confirmed') THEN RAISE EXCEPTION 'confirmed events are append-only' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.state<>'pending' THEN RAISE EXCEPTION 'insert postings before confirming' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN RAISE EXCEPTION 'only confirmation transition is allowed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_guard BEFORE INSERT OR UPDATE OR DELETE ON core.transaction_event FOR EACH ROW EXECUTE FUNCTION core.guard_event();
CREATE FUNCTION core.guard_posting() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE bucket core.ledger_account; category core.dim_category; event core.transaction_event; BEGIN
  SELECT * INTO event FROM core.transaction_event WHERE household_id=NEW.household_id AND id=NEW.event_id FOR UPDATE;
  IF event.state IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'postings require a pending event in this transaction' USING ERRCODE='23514'; END IF;
  SELECT * INTO bucket FROM core.ledger_account WHERE household_id=NEW.household_id AND id=NEW.ledger_account_id;
  IF bucket.currency IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'posting currency mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.currency='INR' AND NEW.native_amount<>NEW.book_amount_inr THEN RAISE EXCEPTION 'INR native and book amounts disagree' USING ERRCODE='23514'; END IF;
  IF NEW.book_amount_inr<>round(NEW.book_amount_inr,2) THEN RAISE EXCEPTION 'INR book values require settlement rounding' USING ERRCODE='23514'; END IF;
  IF NEW.category_id IS NOT NULL THEN
    SELECT * INTO category FROM core.dim_category WHERE household_id=NEW.household_id AND id=NEW.category_id;
    IF bucket.kind NOT IN ('income','expense') OR category.kind IS DISTINCT FROM bucket.kind OR (category.archived AND event.kind<>'reversal') THEN RAISE EXCEPTION 'invalid income/expense category' USING ERRCODE='23514'; END IF;
  END IF;
  IF event.kind IN ('transfer','card_repayment','opening_balance','unresolved_reconciliation') AND bucket.kind IN ('income','expense') THEN RAISE EXCEPTION 'principal movement cannot be ordinary income or expense' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posting_guard BEFORE INSERT ON core.fact_posting FOR EACH ROW EXECUTE FUNCTION core.guard_posting();
CREATE FUNCTION core.check_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE event core.transaction_event; n bigint; total numeric; BEGIN
  SELECT * INTO event FROM core.transaction_event WHERE id=NEW.id;
  SELECT count(*),sum(book_amount_inr) INTO n,total FROM core.fact_posting WHERE household_id=event.household_id AND event_id=event.id;
  IF event.state<>'confirmed' OR n<2 OR total<>0 OR NOT EXISTS(SELECT FROM core.event_source_link WHERE household_id=event.household_id AND event_id=event.id) THEN RAISE EXCEPTION 'event must be confirmed, sourced and exactly balanced with at least two legs' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT FROM core.import_batch WHERE id=event.batch_id AND event.effective_date BETWEEN coverage_start AND coverage_end) THEN RAISE EXCEPTION 'event outside reviewed coverage' USING ERRCODE='23514'; END IF;
  IF event.kind NOT IN ('reversal','fx_conversion') AND (
    n<>2 OR NOT EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind='asset')
    OR EXISTS(SELECT FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND (
      (event.kind IN ('income','income_reversal') AND l.kind NOT IN ('asset','income')) OR
      (event.kind IN ('expense','expense_refund') AND l.kind NOT IN ('asset','expense')) OR
      (event.kind='transfer' AND l.kind<>'asset') OR
      (event.kind='card_repayment' AND l.kind NOT IN ('asset','liability')) OR
      (event.kind IN ('opening_balance','unresolved_reconciliation') AND l.kind NOT IN ('asset','equity')) OR
      (event.kind IN ('income','expense_refund') AND ((l.kind='asset' AND p.book_amount_inr<=0) OR (l.kind<>'asset' AND p.book_amount_inr>=0))) OR
      (event.kind IN ('expense','income_reversal','card_repayment') AND ((l.kind='asset' AND p.book_amount_inr>=0) OR (l.kind<>'asset' AND p.book_amount_inr<=0)))
    )) OR (event.kind<>'transfer' AND (SELECT count(*) FROM core.fact_posting p JOIN core.ledger_account l ON l.id=p.ledger_account_id WHERE p.event_id=event.id AND l.kind='asset')<>1)
  ) THEN RAISE EXCEPTION 'posting shape does not match bank event type' USING ERRCODE='23514'; END IF;
  IF event.reverses_id IS NOT NULL AND (NOT EXISTS(SELECT FROM core.transaction_event WHERE id=event.reverses_id AND state='confirmed') OR EXISTS(
    (SELECT ledger_account_id,currency,native_amount,book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.id EXCEPT ALL SELECT ledger_account_id,currency,-native_amount,-book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.reverses_id)
    UNION ALL
    (SELECT ledger_account_id,currency,-native_amount,-book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.reverses_id EXCEPT ALL SELECT ledger_account_id,currency,native_amount,book_amount_inr,category_id,counterparty_id FROM core.fact_posting WHERE event_id=event.id)
  )) THEN RAISE EXCEPTION 'reversal must negate the original postings exactly' USING ERRCODE='23514'; END IF;
  IF event.replaces_id IS NOT NULL AND NOT EXISTS(SELECT FROM core.transaction_event WHERE household_id=event.household_id AND reverses_id=event.replaces_id AND state='confirmed') THEN RAISE EXCEPTION 'replacement requires a traceable reversal' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER event_complete AFTER INSERT OR UPDATE ON core.transaction_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.check_event_complete();
--> statement-breakpoint
CREATE FUNCTION ops.guard_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (TG_OP='INSERT' AND NEW.revision<>0) OR (TG_OP='UPDATE' AND (NEW.household_id<>OLD.household_id OR NEW.revision<>OLD.revision+1)) THEN RAISE EXCEPTION 'source revision must advance exactly once' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER monotonic_revision BEFORE INSERT OR UPDATE OR DELETE ON ops.source_revision FOR EACH ROW EXECUTE FUNCTION ops.guard_revision();
CREATE FUNCTION core.check_batch_complete() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM core.source_record WHERE batch_id=NEW.id;
  IF n<>NEW.row_count OR NOT EXISTS(SELECT FROM ops.source_revision WHERE household_id=NEW.household_id AND revision>=NEW.revision)
    OR NOT EXISTS(SELECT FROM ops.outbox_event WHERE batch_id=NEW.id AND revision=NEW.revision)
    OR NOT EXISTS(SELECT FROM ops.rebuild_request WHERE batch_id=NEW.id AND revision=NEW.revision AND account_id=NEW.account_id AND earliest_date<=NEW.coverage_start)
    OR EXISTS(SELECT FROM core.fact_posting p JOIN core.transaction_event e ON e.id=p.event_id JOIN core.ledger_account l ON l.id=p.ledger_account_id LEFT JOIN core.holding h ON h.id=l.holding_id WHERE e.batch_id=NEW.id AND coalesce(l.account_id,h.account_id) IS NOT NULL AND NOT EXISTS(SELECT FROM ops.rebuild_request r WHERE r.batch_id=NEW.id AND r.account_id=coalesce(l.account_id,h.account_id) AND r.revision=NEW.revision AND r.earliest_date<=e.effective_date))
    OR EXISTS(SELECT FROM core.source_record s WHERE s.batch_id=NEW.id AND NOT EXISTS(SELECT FROM core.event_source_link l WHERE l.source_id=s.id) AND NOT EXISTS(SELECT FROM core.fact_statement_observation o WHERE o.source_id=s.id))
  THEN RAISE EXCEPTION 'batch requires complete source evidence, revision and durable rebuild intent' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER batch_complete AFTER INSERT ON core.import_batch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.check_batch_complete();
CREATE FUNCTION ops.check_revision_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT FROM core.import_batch WHERE household_id=NEW.household_id AND revision=NEW.revision) THEN RAISE EXCEPTION 'revision requires an atomic confirmed batch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER revision_batch AFTER UPDATE ON ops.source_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ops.check_revision_batch();
CREATE FUNCTION ops.guard_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN RAISE EXCEPTION 'outbox intent is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_intent BEFORE UPDATE OR DELETE ON ops.outbox_event FOR EACH ROW EXECUTE FUNCTION ops.guard_outbox();
--> statement-breakpoint
CREATE FUNCTION core.check_ownership() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a core.ownership_allocation; aid uuid; total numeric; BEGIN
  IF TG_TABLE_NAME='ownership_allocation' THEN aid:=NEW.id; ELSE aid:=NEW.allocation_id; END IF;
  SELECT * INTO a FROM core.ownership_allocation WHERE id=aid;
  -- A real parent-row write also prevents stale-snapshot races at REPEATABLE READ.
  IF a.account_id IS NOT NULL THEN UPDATE core.dim_account SET name=name WHERE id=a.account_id;
  ELSE UPDATE core.holding SET instrument_id=instrument_id WHERE id=a.holding_id; END IF;
  SELECT sum(fraction) INTO total FROM core.ownership_interest WHERE allocation_id=aid;
  IF total IS DISTINCT FROM 1::numeric OR EXISTS(SELECT FROM core.ownership_allocation other WHERE other.household_id=a.household_id AND other.id<>a.id AND other.account_id IS NOT DISTINCT FROM a.account_id AND other.holding_id IS NOT DISTINCT FROM a.holding_id AND daterange(other.valid_from,other.valid_to,'[)') && daterange(a.valid_from,a.valid_to,'[)')) THEN RAISE EXCEPTION 'ownership must total one with non-overlapping intervals' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ownership_complete AFTER INSERT OR UPDATE ON core.ownership_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.check_ownership();
CREATE CONSTRAINT TRIGGER ownership_complete AFTER INSERT OR UPDATE ON core.ownership_interest DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.check_ownership();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON core.ownership_interest FOR EACH ROW EXECUTE FUNCTION core.financial_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON core.ownership_allocation FOR EACH ROW EXECUTE FUNCTION core.financial_immutable();
--> statement-breakpoint
CREATE FUNCTION core.seed_financial_household(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,ops,pg_temp AS $$ BEGIN
  INSERT INTO ops.source_revision(household_id) VALUES(target) ON CONFLICT DO NOTHING;
  INSERT INTO core.dim_instrument(household_id,name,currency) VALUES(target,'Indian rupee','INR') ON CONFLICT DO NOTHING;
  INSERT INTO core.dim_category(household_id,code,name,kind) SELECT target,v.code,v.name,v.kind FROM (VALUES
    ('grocery','Grocery','expense'),('dining','Dining','expense'),('entertainment','Entertainment','expense'),('transport','Transport','expense'),('utilities','Utilities','expense'),('healthcare','Healthcare','expense'),('housing','Housing','expense'),('education','Education','expense'),('fees','Fees & charges','expense'),('other_expense','Other expense','expense'),('salary','Salary','income'),('interest','Interest','income'),('dividends','Dividends','income'),('rental_income','Rental income','income'),('other_income','Other income','income')
  ) AS v(code,name,kind) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION core.seed_new_household() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,ops,pg_temp AS $$ BEGIN PERFORM core.seed_financial_household(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER financial_defaults AFTER INSERT ON core.household FOR EACH ROW EXECUTE FUNCTION core.seed_new_household();
SELECT core.seed_financial_household(id) FROM core.household;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ops FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.seed_financial_household(uuid),core.seed_new_household(),core.financial_immutable(),core.guard_financial_dimension(),core.guard_batch_insert(),core.require_current_batch(),core.guard_event(),core.guard_posting(),core.check_event_complete(),core.check_batch_complete(),core.check_ownership() FROM PUBLIC;
UPDATE core.system_installation SET schema_version=2;

--> statement-breakpoint
ALTER TABLE core.dim_date ADD CHECK (year=extract(year from day)::int AND month=extract(month from day)::int AND financial_year=extract(year from day)::int-CASE WHEN extract(month from day)<4 THEN 1 ELSE 0 END AND financial_quarter=((extract(month from day)::int+8)%12)/3+1);
GRANT INSERT ON core.dim_date TO networth_member;

--> statement-breakpoint
CREATE FUNCTION core.guard_ledger_dimensions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT FROM core.dim_account WHERE id=NEW.account_id AND household_id=NEW.household_id AND currency=NEW.currency) THEN RAISE EXCEPTION 'ledger/account currency mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.holding_id IS NOT NULL AND NOT EXISTS(SELECT FROM core.holding h JOIN core.dim_instrument i ON i.id=h.instrument_id WHERE h.id=NEW.holding_id AND h.household_id=NEW.household_id AND i.currency=NEW.currency AND (NEW.account_id IS NULL OR h.account_id=NEW.account_id)) THEN RAISE EXCEPTION 'ledger holding mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_dimensions BEFORE INSERT ON core.ledger_account FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_dimensions();
CREATE FUNCTION core.guard_position_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'position identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER position_identity BEFORE UPDATE ON core.holding FOR EACH ROW EXECUTE FUNCTION core.guard_position_identity();
CREATE TRIGGER instrument_identity BEFORE UPDATE OR DELETE ON core.dim_instrument FOR EACH ROW EXECUTE FUNCTION core.financial_immutable();
REVOKE EXECUTE ON FUNCTION core.guard_ledger_dimensions(),core.guard_position_identity() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION core.guard_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT FROM core.dim_account WHERE id=NEW.account_id AND household_id=NEW.household_id AND currency=NEW.currency) THEN RAISE EXCEPTION 'observation currency mismatch' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT FROM core.source_record s JOIN core.import_batch b ON b.id=s.batch_id WHERE s.id=NEW.source_id AND b.account_id=NEW.account_id AND NEW.as_of BETWEEN b.coverage_start AND b.coverage_end) THEN RAISE EXCEPTION 'observation outside statement scope' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_scope BEFORE INSERT ON core.fact_statement_observation FOR EACH ROW EXECUTE FUNCTION core.guard_observation();
CREATE FUNCTION core.guard_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE observed numeric; BEGIN
  SELECT balance INTO observed FROM core.fact_statement_observation WHERE id=NEW.observation_id AND household_id=NEW.household_id;
  IF NEW.status<>'unknown' AND (observed IS NULL OR NEW.difference IS DISTINCT FROM observed-NEW.calculated_balance) THEN RAISE EXCEPTION 'reconciliation difference must agree with source evidence' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT FROM ops.source_revision WHERE household_id=NEW.household_id AND revision>=NEW.revision) THEN RAISE EXCEPTION 'reconciliation revision does not exist' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_evidence BEFORE INSERT ON core.reconciliation_result FOR EACH ROW EXECUTE FUNCTION core.guard_reconciliation();
REVOKE EXECUTE ON FUNCTION core.guard_observation(),core.guard_reconciliation() FROM PUBLIC;
REVOKE UPDATE ON ops.outbox_event FROM networth_member;
--> statement-breakpoint
-- Deferred confirmation checks must seek into evidence, not rescan full history per row.
CREATE INDEX financial_source_batch ON core.source_record(batch_id);
CREATE INDEX financial_event_batch ON core.transaction_event(batch_id);
CREATE INDEX financial_event_date ON core.transaction_event(household_id,effective_date);
CREATE INDEX financial_posting_event ON core.fact_posting(event_id);
CREATE INDEX financial_link_source ON core.event_source_link(source_id);
CREATE INDEX financial_link_event ON core.event_source_link(event_id);
CREATE INDEX financial_observation_source ON core.fact_statement_observation(source_id);
CREATE INDEX financial_rebuild_batch ON ops.rebuild_request(batch_id);
CREATE INDEX financial_outbox_batch ON ops.outbox_event(batch_id);
