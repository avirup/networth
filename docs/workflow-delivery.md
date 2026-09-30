# Durable workflow delivery and execution

Phase 6 is complete for the bank-only calculation pipeline. The import transaction commits
financial history and one immutable outbox intent together. Post-commit dispatch records its
claim before making one bounded network attempt. Send failure never rolls back the confirmed
ledger. Stable event IDs, expiring leases and a durable receipt make retries idempotent.

Production callbacks are signed by Inngest, accept at most 256 KiB and carry only household,
batch, outbox and revision identifiers. Preview deployments cannot dispatch or execute work.
A separate restricted database login assumes `networth_worker`; it cannot read authentication
or authoritative financial tables and can use only bounded security-definer functions.

After receipt, `receive-import-v1` runs these durable stages for one household at a time:

1. capture the source high-watermark and coalesce dirty account ranges;
2. calculate exact bank movement/category pages;
3. calculate reconciled native-currency account checkpoints;
4. publish a complete current release manifest.

Each calculation page reserves execution and projected storage before reading inputs. Claims
use a 30-second token lease, one initial attempt plus three retries per checkpoint, at most 100
attempts per work window, and cumulative counters that are never refunded after a crash.
Owner resume preserves lifetime usage and schedules `resume-calculation-v1`. A failed schedule
restores the prior paused state. Newer source evidence causes the old run to become
`superseded`; the triggering import starts one fresh run at the latest revision.

The daily authenticated cron dispatches at most five pending outbox items and cleans expired
pins and unreferenced derived generations. It creates no work for an empty queue and performs
no full-history polling or periodic recalculation.

## Configuration

1. Apply reviewed migrations with `npm run db:migrate` (current schema 10).
2. Create a separate least-privilege Postgres login and set private
   `DATABASE_WORKER_URL`. Hosted connections require `sslmode=verify-full`.
3. Run `npm run workflows:prepare` locally with the admin connection.
4. Configure production Inngest event/signing keys, or `INNGEST_DEV=1` for the explicit
   loopback development environment.
5. Configure an independent `CRON_SECRET` of at least 32 characters. `vercel.json` invokes
   `/api/workflows/recover` once daily.
6. Review actual Neon, Vercel and Inngest usage, shared-account consumption and outstanding
   reservations. Then issue a short lease as documented in
   [complete report publication](report-publication.md).

The owner can manually dispatch pending work from the authenticated API after recent password
confirmation. Capacity expiry, retry exhaustion and work-window exhaustion pause safely;
they do not remove authoritative data or the last published release.

## Verification

Unit tests cover identifier-only events, cron authorization and signature validation.
Postgres tests cover commit preservation, retries, receipts, concurrency, stable revisions,
bounded calculations, resource reservations, stale publication, incremental manifests, pins
and cleanup. The authenticated browser suite covers reviewed import through the published
overview and inspects desktop and mobile layouts. Provider-specific hosted verification still
has to be performed by the installation owner before enabling real imports.
