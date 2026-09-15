# Migration boundary

There are no application migrations in Step 1. Never run migrations during builds,
startup, health checks, or previews. Step 3 adds versioned schema and an advisory-lock
runner requiring bootstrap authorization initially and owner/local authorization
for upgrades. The runtime currently accepts installation schema version 1 only.
