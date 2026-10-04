CREATE FUNCTION ops.installation_status(household uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,ops,core,pg_temp AS $$
DECLARE payload jsonb; BEGIN
 IF core.member_role(household) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object(
  'databaseBytes',pg_database_size(current_database())::text,
  'storageWarningBytes',300000000,
  'storagePauseBytes',400000000,
  'sourceRevision',coalesce((SELECT revision FROM ops.source_revision WHERE household_id=household),0),
  'imports',(SELECT jsonb_build_object('verifiedUntil',verified_until,'workflowVerified',workflow_verified,
    'remainingImports',remaining_imports,'remainingStorageBytes',remaining_storage_bytes::text,'reason',reason) FROM ops.import_admission WHERE singleton),
  'execution',(SELECT jsonb_build_object('verifiedUntil',verified_until,'remainingAttempts',remaining_attempts::text,
    'remainingStorageBytes',remaining_storage_bytes::text) FROM ops.execution_capacity WHERE singleton),
  'pendingDeliveries',(SELECT count(*) FROM ops.workflow_delivery WHERE household_id=household AND state IN ('pending','sending')),
  'pausedDeliveries',(SELECT count(*) FROM ops.workflow_delivery WHERE household_id=household AND state='paused'),
  'pausedCalculations',(SELECT count(*) FROM ops.calculation_budget WHERE household_id=household AND state='paused'),
  'lastBackupAt',(SELECT max(created_at) FROM core.security_audit_event WHERE household_id=household AND kind='backup_exported')
 ) INTO payload;
 RETURN payload;
END $$;
REVOKE ALL ON FUNCTION ops.installation_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.installation_status(uuid) TO networth_member;
UPDATE core.system_installation SET schema_version=11;
