CREATE TABLE "core"."account_facility_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"facility_id" uuid,
	"source_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	CONSTRAINT "facility_link_source" UNIQUE("household_id","account_id","source_id","effective_date")
);
--> statement-breakpoint
CREATE TABLE "core"."card_statement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"payment_due_date" date,
	"minimum_due" numeric,
	CONSTRAINT "card_statement_observation" UNIQUE("household_id","observation_id"),
	CONSTRAINT "card_statement_minimum" CHECK ("core"."card_statement"."minimum_due" is null or ("core"."card_statement"."minimum_due">=0 and "core"."card_statement"."minimum_due"<1e26 and scale("core"."card_statement"."minimum_due")<=2))
);
--> statement-breakpoint
CREATE TABLE "core"."credit_facility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	CONSTRAINT "credit_facility_scope" UNIQUE("household_id","id"),
	CONSTRAINT "credit_facility_name" CHECK (length(btrim("core"."credit_facility"."name")) between 1 and 100),
	CONSTRAINT "credit_facility_currency" CHECK ("core"."credit_facility"."currency"='INR')
);
--> statement-breakpoint
CREATE TABLE "core"."credit_facility_term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"limit_inr" numeric,
	CONSTRAINT "facility_term_source" UNIQUE("household_id","facility_id","source_id","effective_date"),
	CONSTRAINT "facility_term_limit" CHECK ("core"."credit_facility_term"."limit_inr" is null or ("core"."credit_facility_term"."limit_inr">=0 and "core"."credit_facility_term"."limit_inr"<1e26 and scale("core"."credit_facility_term"."limit_inr")<=2))
);
--> statement-breakpoint
ALTER TABLE "core"."account_facility_link" ADD CONSTRAINT "account_facility_link_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."account_facility_link" ADD CONSTRAINT "account_facility_link_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."account_facility_link" ADD CONSTRAINT "account_facility_link_household_id_facility_id_credit_facility_household_id_id_fk" FOREIGN KEY ("household_id","facility_id") REFERENCES "core"."credit_facility"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."account_facility_link" ADD CONSTRAINT "account_facility_link_household_id_source_id_source_record_household_id_id_fk" FOREIGN KEY ("household_id","source_id") REFERENCES "core"."source_record"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."card_statement" ADD CONSTRAINT "card_statement_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."card_statement" ADD CONSTRAINT "card_statement_household_id_observation_id_fact_statement_observation_household_id_id_fk" FOREIGN KEY ("household_id","observation_id") REFERENCES "core"."fact_statement_observation"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credit_facility" ADD CONSTRAINT "credit_facility_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credit_facility_term" ADD CONSTRAINT "credit_facility_term_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credit_facility_term" ADD CONSTRAINT "credit_facility_term_household_id_facility_id_credit_facility_household_id_id_fk" FOREIGN KEY ("household_id","facility_id") REFERENCES "core"."credit_facility"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credit_facility_term" ADD CONSTRAINT "credit_facility_term_household_id_source_id_source_record_household_id_id_fk" FOREIGN KEY ("household_id","source_id") REFERENCES "core"."source_record"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_link_date" ON "core"."account_facility_link" USING btree ("household_id","account_id","effective_date");--> statement-breakpoint
CREATE INDEX "facility_term_date" ON "core"."credit_facility_term" USING btree ("household_id","facility_id","effective_date");
--> statement-breakpoint
ALTER TABLE core.import_batch DROP CONSTRAINT import_batch_0;
ALTER TABLE core.import_batch ADD CONSTRAINT import_batch_0 CHECK(schema_version IN ('bank-v1','card-v1'));

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['credit_facility','credit_facility_term','account_facility_link','card_statement'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY card_admin ON core.%I TO %I USING(true) WITH CHECK(true)',tab,current_user);
  EXECUTE format('CREATE POLICY card_read ON core.%I FOR SELECT TO networth_member USING(core.member_role(household_id) IS NOT NULL)',tab);
  EXECUTE format('CREATE POLICY card_insert ON core.%I FOR INSERT TO networth_member WITH CHECK(core.member_role(household_id) IN (''owner'',''editor''))',tab);
  EXECUTE format('GRANT SELECT,INSERT ON core.%I TO networth_member',tab);
  EXECUTE format('REVOKE ALL ON core.%I FROM PUBLIC,networth_auth,networth_worker',tab);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.financial_immutable()',tab);
 END LOOP;
END $$;

CREATE FUNCTION core.guard_card_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,core,pg_temp AS $$
DECLARE evidence core.source_record; batch core.import_batch; observation core.fact_statement_observation; BEGIN
 IF TG_TABLE_NAME='card_statement' THEN
  SELECT * INTO observation FROM core.fact_statement_observation WHERE id=NEW.observation_id AND household_id=NEW.household_id;
  SELECT * INTO evidence FROM core.source_record WHERE id=observation.source_id AND household_id=NEW.household_id;
 ELSE
  SELECT * INTO evidence FROM core.source_record WHERE id=NEW.source_id AND household_id=NEW.household_id;
 END IF;
 SELECT * INTO batch FROM core.import_batch WHERE id=evidence.batch_id AND household_id=NEW.household_id;
 IF batch.id IS NULL OR batch.created_xid<>pg_current_xact_id() OR batch.schema_version<>'card-v1'
 OR NOT EXISTS(SELECT FROM core.dim_account WHERE id=batch.account_id AND household_id=NEW.household_id AND kind='credit_card' AND currency='INR')
 THEN RAISE EXCEPTION 'card evidence requires its current reviewed card batch' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='card_statement' THEN
  IF observation.kind<>'closing' OR observation.account_id<>batch.account_id OR observation.as_of<>batch.coverage_end
   OR (NEW.payment_due_date IS NOT NULL AND NEW.payment_due_date<observation.as_of)
   OR (NEW.minimum_due IS NOT NULL AND observation.balance IS NOT NULL AND NEW.minimum_due>greatest(observation.balance,0))
  THEN RAISE EXCEPTION 'card due information must agree with closing statement evidence' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.effective_date<batch.coverage_start OR NEW.effective_date>batch.coverage_end
  THEN RAISE EXCEPTION 'facility evidence is outside reviewed coverage' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='account_facility_link' THEN
   IF NEW.account_id<>batch.account_id THEN RAISE EXCEPTION 'facility link must belong to the source card' USING ERRCODE='23514'; END IF;
   IF EXISTS(SELECT FROM core.account_facility_link l JOIN core.source_record s ON s.id=l.source_id AND s.household_id=l.household_id
    WHERE l.household_id=NEW.household_id AND l.account_id=NEW.account_id AND l.effective_date=NEW.effective_date AND s.batch_id=batch.id)
   THEN RAISE EXCEPTION 'conflicting account facility evidence in one batch' USING ERRCODE='23514'; END IF;
  ELSE
   IF EXISTS(SELECT FROM core.credit_facility_term t JOIN core.source_record s ON s.id=t.source_id AND s.household_id=t.household_id
    WHERE t.household_id=NEW.household_id AND t.facility_id=NEW.facility_id AND t.effective_date=NEW.effective_date AND s.batch_id=batch.id)
   THEN RAISE EXCEPTION 'conflicting facility limit evidence in one batch' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER card_evidence BEFORE INSERT ON core.credit_facility_term FOR EACH ROW EXECUTE FUNCTION core.guard_card_evidence();
CREATE TRIGGER card_evidence BEFORE INSERT ON core.account_facility_link FOR EACH ROW EXECUTE FUNCTION core.guard_card_evidence();
CREATE TRIGGER card_evidence BEFORE INSERT ON core.card_statement FOR EACH ROW EXECUTE FUNCTION core.guard_card_evidence();
REVOKE ALL ON FUNCTION core.guard_card_evidence() FROM PUBLIC;
UPDATE core.system_installation SET schema_version=12;
