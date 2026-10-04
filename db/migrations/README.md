# Migration boundary

Never run migrations during builds, startup, health checks or previews. Versioned,
checksummed migrations use one advisory lock and require bootstrap authorization for a
new installation or the private local administrator command for upgrades. The runtime
currently accepts schema 13. Migration 0012 adds the owner-only operational status query
used by the encrypted backup milestone; backup payloads contain data, not migration SQL.

Migration 0013 adds append-only card facility terms, account links and statement
metadata, household isolation and import-evidence guards. Migration 0014 enables atomic
card confirmation and authenticated same-release liability reporting.
