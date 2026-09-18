CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TABLE "core"."dim_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"institution_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bank' NOT NULL,
	"currency" text NOT NULL,
	"masked_reference" text,
	"opened_on" date,
	"closed_on" date,
	CONSTRAINT "dim_account_scope" UNIQUE("household_id","id"),
	CONSTRAINT "dim_account_0" CHECK (length("core"."dim_account"."name") between 1 and 100),
	CONSTRAINT "dim_account_1" CHECK ("core"."dim_account"."masked_reference" is null or "core"."dim_account"."masked_reference" ~ '^[*]{4}[A-Za-z0-9]{0,4}$'),
	CONSTRAINT "dim_account_2" CHECK ("core"."dim_account"."kind" in ('bank','cash','credit_card','custody')),
	CONSTRAINT "dim_account_3" CHECK ("core"."dim_account"."closed_on" is null or "core"."dim_account"."opened_on" is null or "core"."dim_account"."closed_on" >= "core"."dim_account"."opened_on")
);
--> statement-breakpoint
CREATE TABLE "core"."import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"coverage_start" date NOT NULL,
	"coverage_end" date NOT NULL,
	"completeness" text NOT NULL,
	"row_count" integer NOT NULL,
	"request_bytes" integer NOT NULL,
	"revision" integer NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batch_scope" UNIQUE("household_id","id"),
	CONSTRAINT "batch_retry" UNIQUE("household_id","idempotency_key"),
	CONSTRAINT "batch_revision" UNIQUE("household_id","revision"),
	CONSTRAINT "import_batch_0" CHECK ("core"."import_batch"."schema_version"='bank-v1'),
	CONSTRAINT "import_batch_1" CHECK ("core"."import_batch"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_batch_2" CHECK ("core"."import_batch"."coverage_start"<="core"."import_batch"."coverage_end"),
	CONSTRAINT "import_batch_3" CHECK ("core"."import_batch"."completeness" in ('complete','partial','balance_only')),
	CONSTRAINT "import_batch_4" CHECK ("core"."import_batch"."row_count" between 1 and 5000 and "core"."import_batch"."request_bytes" between 1 and 3000000 and "core"."import_batch"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "core"."dim_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dim_category_scope" UNIQUE("household_id","id"),
	CONSTRAINT "category_code" UNIQUE("household_id","code"),
	CONSTRAINT "dim_category_0" CHECK ("core"."dim_category"."code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "dim_category_1" CHECK ("core"."dim_category"."kind" in ('income','expense')),
	CONSTRAINT "dim_category_2" CHECK (length("core"."dim_category"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "core"."dim_counterparty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "dim_counterparty_scope" UNIQUE("household_id","id"),
	CONSTRAINT "dim_counterparty_0" CHECK (length("core"."dim_counterparty"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "core"."dim_currency" (
	"code" text PRIMARY KEY NOT NULL,
	"settlement_digits" integer NOT NULL,
	CONSTRAINT "currency_code" CHECK ("core"."dim_currency"."code" ~ '^[A-Z]{3}$' and "core"."dim_currency"."settlement_digits" between 0 and 12)
);
--> statement-breakpoint
CREATE TABLE "core"."dim_date" (
	"day" date PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"financial_year" integer NOT NULL,
	"financial_quarter" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."transaction_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_date" date NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"quality" text DEFAULT 'complete' NOT NULL,
	"review_note" text,
	"reverses_id" uuid,
	"replaces_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_event_scope" UNIQUE("household_id","id"),
	CONSTRAINT "single_reversal" UNIQUE("household_id","reverses_id"),
	CONSTRAINT "transaction_event_0" CHECK ("core"."transaction_event"."kind" in ('income','expense','expense_refund','income_reversal','transfer','card_repayment','opening_balance','unresolved_reconciliation','fx_conversion','reversal')),
	CONSTRAINT "transaction_event_1" CHECK ("core"."transaction_event"."state" in ('pending','confirmed')),
	CONSTRAINT "transaction_event_2" CHECK ("core"."transaction_event"."quality" in ('complete','opening_history_unknown','unresolved')),
	CONSTRAINT "transaction_event_3" CHECK ("core"."transaction_event"."kind" not in ('opening_balance','unresolved_reconciliation') or (length(btrim("core"."transaction_event"."review_note"))>0 and "core"."transaction_event"."quality"<>'complete'))
);
--> statement-breakpoint
CREATE TABLE "core"."holding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	CONSTRAINT "holding_scope" UNIQUE("household_id","id"),
	CONSTRAINT "holding_position" UNIQUE("household_id","account_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "core"."dim_institution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bank' NOT NULL,
	CONSTRAINT "dim_institution_scope" UNIQUE("household_id","id"),
	CONSTRAINT "dim_institution_0" CHECK (length("core"."dim_institution"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "core"."dim_instrument" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"product_type" text DEFAULT 'cash' NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "dim_instrument_scope" UNIQUE("household_id","id"),
	CONSTRAINT "cash_currency" UNIQUE("household_id","currency"),
	CONSTRAINT "dim_instrument_0" CHECK ("core"."dim_instrument"."product_type" = 'cash'),
	CONSTRAINT "dim_instrument_1" CHECK (length("core"."dim_instrument"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "core"."ledger_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid,
	"holding_id" uuid,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "ledger_account_scope" UNIQUE("household_id","id"),
	CONSTRAINT "ledger_code" UNIQUE("household_id","code"),
	CONSTRAINT "ledger_account_0" CHECK ("core"."ledger_account"."kind" in ('asset','liability','equity','income','expense')),
	CONSTRAINT "ledger_account_1" CHECK (length("core"."ledger_account"."code") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "core"."fact_statement_observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"kind" text NOT NULL,
	"balance" numeric,
	"unknown_reason" text,
	"currency" text NOT NULL,
	CONSTRAINT "fact_statement_observation_scope" UNIQUE("household_id","id"),
	CONSTRAINT "fact_statement_observation_0" CHECK ("core"."fact_statement_observation"."kind" in ('opening','closing')),
	CONSTRAINT "fact_statement_observation_1" CHECK (("core"."fact_statement_observation"."balance" is null and length(btrim("core"."fact_statement_observation"."unknown_reason"))>0) or ("core"."fact_statement_observation"."balance" is not null and "core"."fact_statement_observation"."unknown_reason" is null)),
	CONSTRAINT "fact_statement_observation_2" CHECK ("core"."fact_statement_observation"."balance" is null or abs("core"."fact_statement_observation"."balance")<1e26)
);
--> statement-breakpoint
CREATE TABLE "ops"."outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_event_scope" UNIQUE("household_id","id"),
	CONSTRAINT "outbox_batch" UNIQUE("household_id","batch_id"),
	CONSTRAINT "outbox_event_0" CHECK ("ops"."outbox_event"."revision">0),
	CONSTRAINT "outbox_event_1" CHECK ("ops"."outbox_event"."state" in ('pending','dispatched'))
);
--> statement-breakpoint
CREATE TABLE "core"."dim_owner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entity_type" text DEFAULT 'individual' NOT NULL,
	CONSTRAINT "dim_owner_scope" UNIQUE("household_id","id"),
	CONSTRAINT "dim_owner_0" CHECK (length("core"."dim_owner"."name") between 1 and 100),
	CONSTRAINT "dim_owner_1" CHECK ("core"."dim_owner"."entity_type" in ('individual','entity'))
);
--> statement-breakpoint
CREATE TABLE "core"."ownership_interest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"fraction" numeric NOT NULL,
	CONSTRAINT "ownership_interest_scope" UNIQUE("household_id","id"),
	CONSTRAINT "allocation_owner" UNIQUE("household_id","allocation_id","owner_id"),
	CONSTRAINT "ownership_interest_0" CHECK ("core"."ownership_interest"."fraction" >= 0 and "core"."ownership_interest"."fraction" <= 1)
);
--> statement-breakpoint
CREATE TABLE "core"."ownership_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid,
	"holding_id" uuid,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_allocation_scope" UNIQUE("household_id","id"),
	CONSTRAINT "ownership_allocation_0" CHECK (num_nonnulls("core"."ownership_allocation"."account_id","core"."ownership_allocation"."holding_id")=1),
	CONSTRAINT "ownership_allocation_1" CHECK ("core"."ownership_allocation"."valid_to" is null or "core"."ownership_allocation"."valid_to">"core"."ownership_allocation"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "core"."fact_posting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"native_amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"book_amount_inr" numeric NOT NULL,
	"category_id" uuid,
	"counterparty_id" uuid,
	CONSTRAINT "fact_posting_scope" UNIQUE("household_id","id"),
	CONSTRAINT "posting_line" UNIQUE("household_id","event_id","line_number"),
	CONSTRAINT "fact_posting_0" CHECK ("core"."fact_posting"."line_number">0),
	CONSTRAINT "fact_posting_1" CHECK (abs("core"."fact_posting"."native_amount")<1e26 and scale("core"."fact_posting"."native_amount")<=12),
	CONSTRAINT "fact_posting_2" CHECK (abs("core"."fact_posting"."book_amount_inr")<1e26 and scale("core"."fact_posting"."book_amount_inr")<=12)
);
--> statement-breakpoint
CREATE TABLE "ops"."rebuild_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"earliest_date" date NOT NULL,
	"revision" integer NOT NULL,
	"cause" text DEFAULT 'bank_import' NOT NULL,
	CONSTRAINT "rebuild_request_scope" UNIQUE("household_id","id"),
	CONSTRAINT "rebuild_batch_account" UNIQUE("household_id","batch_id","account_id"),
	CONSTRAINT "rebuild_request_0" CHECK ("ops"."rebuild_request"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "core"."reconciliation_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"calculated_balance" numeric,
	"difference" numeric,
	"explanation" text,
	"resolution_event_id" uuid,
	CONSTRAINT "reconciliation_result_scope" UNIQUE("household_id","id"),
	CONSTRAINT "reconciliation_result_0" CHECK ("core"."reconciliation_result"."revision">0),
	CONSTRAINT "reconciliation_result_1" CHECK (("core"."reconciliation_result"."status"='unknown' and "core"."reconciliation_result"."calculated_balance" is null and "core"."reconciliation_result"."difference" is null and length(btrim("core"."reconciliation_result"."explanation"))>0) or ("core"."reconciliation_result"."status"='matched' and "core"."reconciliation_result"."calculated_balance" is not null and "core"."reconciliation_result"."difference"=0) or ("core"."reconciliation_result"."status"='mismatch' and "core"."reconciliation_result"."calculated_balance" is not null and "core"."reconciliation_result"."difference"<>0 and length(btrim("core"."reconciliation_result"."explanation"))>0))
);
--> statement-breakpoint
CREATE TABLE "core"."reporting_scope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reporting_scope_scope" UNIQUE("household_id","id"),
	CONSTRAINT "reporting_scope_0" CHECK ("core"."reporting_scope"."version">0),
	CONSTRAINT "reporting_scope_1" CHECK (length("core"."reporting_scope"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "ops"."source_revision" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "revision_nonnegative" CHECK ("ops"."source_revision"."revision">=0)
);
--> statement-breakpoint
CREATE TABLE "core"."scope_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"owner_id" uuid,
	"account_id" uuid,
	"holding_id" uuid,
	"valid_from" date NOT NULL,
	"valid_to" date,
	CONSTRAINT "scope_member_scope" UNIQUE("household_id","id"),
	CONSTRAINT "scope_member_0" CHECK (num_nonnulls("core"."scope_member"."owner_id","core"."scope_member"."account_id","core"."scope_member"."holding_id")=1),
	CONSTRAINT "scope_member_1" CHECK ("core"."scope_member"."valid_to" is null or "core"."scope_member"."valid_to">"core"."scope_member"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "core"."event_source_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "event_source_link_scope" UNIQUE("household_id","id"),
	CONSTRAINT "source_event" UNIQUE("household_id","event_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "core"."source_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"provider_reference" text,
	"row_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "source_record_scope" UNIQUE("household_id","id"),
	CONSTRAINT "source_row" UNIQUE("household_id","batch_id","row_number"),
	CONSTRAINT "source_record_0" CHECK ("core"."source_record"."row_number" between 1 and 5000),
	CONSTRAINT "source_record_1" CHECK ("core"."source_record"."row_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_record_2" CHECK (octet_length("core"."source_record"."payload"::text)<=16000)
);
--> statement-breakpoint
ALTER TABLE "core"."dim_account" ADD CONSTRAINT "dim_account_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_account" ADD CONSTRAINT "dim_account_currency_dim_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."dim_currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_account" ADD CONSTRAINT "dim_account_household_id_institution_id_dim_institution_household_id_id_fk" FOREIGN KEY ("household_id","institution_id") REFERENCES "core"."dim_institution"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."import_batch" ADD CONSTRAINT "import_batch_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."import_batch" ADD CONSTRAINT "import_batch_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_category" ADD CONSTRAINT "dim_category_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_counterparty" ADD CONSTRAINT "dim_counterparty_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transaction_event" ADD CONSTRAINT "transaction_event_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."transaction_event" ADD CONSTRAINT "transaction_event_household_id_batch_id_import_batch_household_id_id_fk" FOREIGN KEY ("household_id","batch_id") REFERENCES "core"."import_batch"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holding" ADD CONSTRAINT "holding_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holding" ADD CONSTRAINT "holding_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."holding" ADD CONSTRAINT "holding_household_id_instrument_id_dim_instrument_household_id_id_fk" FOREIGN KEY ("household_id","instrument_id") REFERENCES "core"."dim_instrument"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_institution" ADD CONSTRAINT "dim_institution_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_instrument" ADD CONSTRAINT "dim_instrument_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_instrument" ADD CONSTRAINT "dim_instrument_currency_dim_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."dim_currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ledger_account" ADD CONSTRAINT "ledger_account_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ledger_account" ADD CONSTRAINT "ledger_account_currency_dim_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."dim_currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ledger_account" ADD CONSTRAINT "ledger_account_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ledger_account" ADD CONSTRAINT "ledger_account_household_id_holding_id_holding_household_id_id_fk" FOREIGN KEY ("household_id","holding_id") REFERENCES "core"."holding"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_statement_observation" ADD CONSTRAINT "fact_statement_observation_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_statement_observation" ADD CONSTRAINT "fact_statement_observation_currency_dim_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."dim_currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_statement_observation" ADD CONSTRAINT "fact_statement_observation_household_id_source_id_source_record_household_id_id_fk" FOREIGN KEY ("household_id","source_id") REFERENCES "core"."source_record"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_statement_observation" ADD CONSTRAINT "fact_statement_observation_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."outbox_event" ADD CONSTRAINT "outbox_event_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."outbox_event" ADD CONSTRAINT "outbox_event_household_id_batch_id_import_batch_household_id_id_fk" FOREIGN KEY ("household_id","batch_id") REFERENCES "core"."import_batch"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dim_owner" ADD CONSTRAINT "dim_owner_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ownership_interest" ADD CONSTRAINT "ownership_interest_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ownership_interest" ADD CONSTRAINT "ownership_interest_household_id_allocation_id_ownership_allocation_household_id_id_fk" FOREIGN KEY ("household_id","allocation_id") REFERENCES "core"."ownership_allocation"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ownership_interest" ADD CONSTRAINT "ownership_interest_household_id_owner_id_dim_owner_household_id_id_fk" FOREIGN KEY ("household_id","owner_id") REFERENCES "core"."dim_owner"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ownership_allocation" ADD CONSTRAINT "ownership_allocation_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ownership_allocation" ADD CONSTRAINT "ownership_allocation_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ownership_allocation" ADD CONSTRAINT "ownership_allocation_household_id_holding_id_holding_household_id_id_fk" FOREIGN KEY ("household_id","holding_id") REFERENCES "core"."holding"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_posting" ADD CONSTRAINT "fact_posting_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_posting" ADD CONSTRAINT "fact_posting_currency_dim_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "core"."dim_currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_posting" ADD CONSTRAINT "fact_posting_household_id_event_id_transaction_event_household_id_id_fk" FOREIGN KEY ("household_id","event_id") REFERENCES "core"."transaction_event"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_posting" ADD CONSTRAINT "fact_posting_household_id_ledger_account_id_ledger_account_household_id_id_fk" FOREIGN KEY ("household_id","ledger_account_id") REFERENCES "core"."ledger_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_posting" ADD CONSTRAINT "fact_posting_household_id_category_id_dim_category_household_id_id_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "core"."dim_category"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."fact_posting" ADD CONSTRAINT "fact_posting_household_id_counterparty_id_dim_counterparty_household_id_id_fk" FOREIGN KEY ("household_id","counterparty_id") REFERENCES "core"."dim_counterparty"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."rebuild_request" ADD CONSTRAINT "rebuild_request_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."rebuild_request" ADD CONSTRAINT "rebuild_request_household_id_batch_id_import_batch_household_id_id_fk" FOREIGN KEY ("household_id","batch_id") REFERENCES "core"."import_batch"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."rebuild_request" ADD CONSTRAINT "rebuild_request_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_result" ADD CONSTRAINT "reconciliation_result_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_result" ADD CONSTRAINT "reconciliation_result_household_id_observation_id_fact_statement_observation_household_id_id_fk" FOREIGN KEY ("household_id","observation_id") REFERENCES "core"."fact_statement_observation"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reconciliation_result" ADD CONSTRAINT "reconciliation_result_household_id_resolution_event_id_transaction_event_household_id_id_fk" FOREIGN KEY ("household_id","resolution_event_id") REFERENCES "core"."transaction_event"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."reporting_scope" ADD CONSTRAINT "reporting_scope_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."source_revision" ADD CONSTRAINT "source_revision_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."scope_member" ADD CONSTRAINT "scope_member_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."scope_member" ADD CONSTRAINT "scope_member_household_id_scope_id_reporting_scope_household_id_id_fk" FOREIGN KEY ("household_id","scope_id") REFERENCES "core"."reporting_scope"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."scope_member" ADD CONSTRAINT "scope_member_household_id_owner_id_dim_owner_household_id_id_fk" FOREIGN KEY ("household_id","owner_id") REFERENCES "core"."dim_owner"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."scope_member" ADD CONSTRAINT "scope_member_household_id_account_id_dim_account_household_id_id_fk" FOREIGN KEY ("household_id","account_id") REFERENCES "core"."dim_account"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."scope_member" ADD CONSTRAINT "scope_member_household_id_holding_id_holding_household_id_id_fk" FOREIGN KEY ("household_id","holding_id") REFERENCES "core"."holding"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_source_link" ADD CONSTRAINT "event_source_link_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_source_link" ADD CONSTRAINT "event_source_link_household_id_event_id_transaction_event_household_id_id_fk" FOREIGN KEY ("household_id","event_id") REFERENCES "core"."transaction_event"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_source_link" ADD CONSTRAINT "event_source_link_household_id_source_id_source_record_household_id_id_fk" FOREIGN KEY ("household_id","source_id") REFERENCES "core"."source_record"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."source_record" ADD CONSTRAINT "source_record_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."source_record" ADD CONSTRAINT "source_record_household_id_batch_id_import_batch_household_id_id_fk" FOREIGN KEY ("household_id","batch_id") REFERENCES "core"."import_batch"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_fingerprint" ON "core"."source_record" USING btree ("household_id","row_hash");