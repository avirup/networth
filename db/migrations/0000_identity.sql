CREATE SCHEMA IF NOT EXISTS "core";
--> statement-breakpoint
CREATE TYPE "core"."access_state" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "core"."member_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "core"."auth_attempt" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "positive_attempts" CHECK ("core"."auth_attempt"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."security_audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid,
	"result" text DEFAULT 'success' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."auth_credential" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."household" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_name_length" CHECK (length("core"."household"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "core"."system_installation" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"setup_completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_installation_id_unique" UNIQUE("id"),
	CONSTRAINT "installation_singleton" CHECK ("core"."system_installation"."singleton" = true),
	CONSTRAINT "positive_schema_version" CHECK ("core"."system_installation"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."auth_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "core"."member_role" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitation_non_owner" CHECK ("core"."auth_invitation"."role" in ('editor', 'viewer')),
	CONSTRAINT "invitation_email" CHECK ("core"."auth_invitation"."email" = lower(btrim("core"."auth_invitation"."email")) and length("core"."auth_invitation"."email") <= 254)
);
--> statement-breakpoint
CREATE TABLE "core"."household_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "core"."member_role" NOT NULL,
	"state" "core"."access_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_household_user" UNIQUE("household_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "core"."auth_recovery_code" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."auth_reset_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_reset_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "core"."auth_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"reauthenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_hash_length" CHECK (length("core"."auth_session"."token_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "core"."auth_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"state" "core"."access_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email"),
	CONSTRAINT "normalized_email" CHECK ("core"."auth_user"."email" = lower(btrim("core"."auth_user"."email")) and length("core"."auth_user"."email") between 3 and 254),
	CONSTRAINT "bounded_name" CHECK (length("core"."auth_user"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "core"."security_audit_event" ADD CONSTRAINT "security_audit_event_household_id_actor_id_household_membership_household_id_user_id_fk" FOREIGN KEY ("household_id","actor_id") REFERENCES "core"."household_membership"("household_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."auth_credential" ADD CONSTRAINT "auth_credential_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."system_installation" ADD CONSTRAINT "system_installation_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."auth_invitation" ADD CONSTRAINT "auth_invitation_household_id_created_by_household_membership_household_id_user_id_fk" FOREIGN KEY ("household_id","created_by") REFERENCES "core"."household_membership"("household_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."household_membership" ADD CONSTRAINT "household_membership_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "core"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."household_membership" ADD CONSTRAINT "household_membership_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."auth_recovery_code" ADD CONSTRAINT "auth_recovery_code_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."auth_reset_token" ADD CONSTRAINT "auth_reset_token_household_id_user_id_household_membership_household_id_user_id_fk" FOREIGN KEY ("household_id","user_id") REFERENCES "core"."household_membership"("household_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."auth_reset_token" ADD CONSTRAINT "auth_reset_token_household_id_created_by_household_membership_household_id_user_id_fk" FOREIGN KEY ("household_id","created_by") REFERENCES "core"."household_membership"("household_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_expiry" ON "core"."auth_attempt" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_household_time" ON "core"."security_audit_event" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "invitation_household" ON "core"."auth_invitation" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "membership_user" ON "core"."household_membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recovery_user" ON "core"."auth_recovery_code" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reset_user" ON "core"."auth_reset_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user" ON "core"."auth_session" USING btree ("user_id");