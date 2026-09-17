-- Auth and member connections deliberately have different database privileges.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'networth_auth') THEN CREATE ROLE networth_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'networth_member') THEN CREATE ROLE networth_member NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'networth_worker') THEN CREATE ROLE networth_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
END $$;
--> statement-breakpoint
GRANT networth_auth, networth_member TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
REVOKE ALL ON SCHEMA core FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC;
GRANT USAGE ON SCHEMA core TO networth_auth, networth_member;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO networth_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO networth_auth;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['auth_user','auth_credential','auth_session','household','household_membership','system_installation','auth_invitation','auth_recovery_code','auth_reset_token','auth_attempt','security_audit_event'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY auth_service ON core.%I TO networth_auth USING (true) WITH CHECK (true)',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION core.member_role(household uuid) RETURNS core.member_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp AS $$
  SELECT m.role FROM core.household_membership m
  JOIN core.auth_user u ON u.id=m.user_id
  JOIN core.auth_session s ON s.user_id=u.id
  WHERE m.household_id=household AND m.state='active' AND u.state='active'
    AND s.token_hash=current_setting('app.session_hash',true)
    AND u.id::text=current_setting('app.user_id',true)
    AND household::text=current_setting('app.household_id',true)
    AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
  LIMIT 1
$$;
GRANT CREATE ON SCHEMA core TO networth_auth;
ALTER FUNCTION core.member_role(uuid) OWNER TO networth_auth;
REVOKE CREATE ON SCHEMA core FROM networth_auth;
REVOKE ALL ON FUNCTION core.member_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.member_role(uuid) TO networth_member;
GRANT SELECT ON core.household, core.household_membership TO networth_member;
GRANT UPDATE(name) ON core.household TO networth_member;
CREATE POLICY household_read ON core.household FOR SELECT TO networth_member USING (core.member_role(id) IS NOT NULL);
CREATE POLICY household_manage ON core.household FOR UPDATE TO networth_member USING (core.member_role(id)='owner') WITH CHECK (core.member_role(id)='owner');
CREATE POLICY membership_read ON core.household_membership FOR SELECT TO networth_member
 USING (core.member_role(household_id) IS NOT NULL AND (user_id::text=current_setting('app.user_id',true) OR core.member_role(household_id)='owner'));
--> statement-breakpoint
CREATE FUNCTION core.guard_membership_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,pg_temp AS $$
DECLARE user_state core.access_state;
BEGIN
  SELECT state INTO user_state FROM core.auth_user WHERE id=NEW.user_id FOR UPDATE;
  IF NEW.role='owner' AND NEW.state='active' AND user_state IS DISTINCT FROM 'active'::core.access_state THEN
    RAISE EXCEPTION 'active ownership requires an active identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_user_guard BEFORE INSERT OR UPDATE ON core.household_membership FOR EACH ROW EXECUTE FUNCTION core.guard_membership_user();
CREATE FUNCTION core.guard_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,pg_temp AS $$
DECLARE target_household uuid;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.household_id<>OLD.household_id OR NEW.user_id<>OLD.user_id) THEN RAISE EXCEPTION 'membership identity is immutable' USING ERRCODE='23514'; END IF;
  target_household := CASE WHEN TG_OP='DELETE' THEN OLD.household_id ELSE NEW.household_id END;
  -- Serialize all owner-set changes, including direct SQL writes. The following
  -- statement uses a fresh READ COMMITTED snapshot after acquiring this lock.
  UPDATE core.household SET name=name WHERE id=target_household;
  IF NOT EXISTS (SELECT 1 FROM core.household_membership m JOIN core.auth_user u ON u.id=m.user_id WHERE m.household_id=target_household AND m.role='owner' AND m.state='active' AND u.state='active') THEN
    RAISE EXCEPTION 'at least one active owner is required' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER membership_owner_guard AFTER UPDATE OR DELETE ON core.household_membership FOR EACH ROW EXECUTE FUNCTION core.guard_owner();
CREATE FUNCTION core.guard_new_household() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,pg_temp AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.household_membership m JOIN core.auth_user u ON u.id=m.user_id WHERE m.household_id=NEW.id AND m.role='owner' AND m.state='active' AND u.state='active') THEN RAISE EXCEPTION 'household requires an owner' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER household_owner_guard AFTER INSERT ON core.household DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.guard_new_household();
CREATE FUNCTION core.guard_user_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,core,pg_temp AS $$ BEGIN
  IF NEW.state='disabled' AND EXISTS(SELECT 1 FROM core.household_membership WHERE user_id=OLD.id AND state='active' AND role='owner') THEN RAISE EXCEPTION 'remove active ownership before disabling identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_owner_guard BEFORE UPDATE ON core.auth_user FOR EACH ROW EXECUTE FUNCTION core.guard_user_state();
--> statement-breakpoint
CREATE FUNCTION core.guard_installation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'completed setup is irreversible' USING ERRCODE='23514'; END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.id IS DISTINCT FROM OLD.id OR NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.setup_completed_at IS DISTINCT FROM OLD.setup_completed_at THEN RAISE EXCEPTION 'completed setup is irreversible' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_guard BEFORE UPDATE OR DELETE ON core.system_installation FOR EACH ROW EXECUTE FUNCTION core.guard_installation();
CREATE FUNCTION core.guard_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'security history is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER audit_guard BEFORE UPDATE OR DELETE ON core.security_audit_event FOR EACH ROW EXECUTE FUNCTION core.guard_audit();
REVOKE UPDATE, DELETE ON core.security_audit_event FROM networth_auth;
REVOKE DELETE ON core.system_installation FROM networth_auth;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA core FROM PUBLIC;
