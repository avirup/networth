# Encrypted local backup and restore

Schema 13 backs up bank/card records and card facility/statement evidence tables.
Backups are
created on a trusted administration computer and stored by the installation owner. The
application does not upload them, retain their passphrase or introduce an object-storage
service.

## Format and consistency

`networth-backup-v1` is a directory containing a small plaintext `backup.json` envelope,
an encrypted manifest and encrypted data parts. The envelope contains only cryptographic
parameters, file names, sizes and ciphertext checksums. Household identifiers, counts,
table names, source revisions and financial rows are inside authenticated encryption.

Each data part contains at most 1,000 JSON rows and 2,500,000 plaintext bytes; encrypted
files may not exceed 3,000,000 bytes. AES-256-GCM authenticates every file independently.
The key is derived from the owner-supplied passphrase with scrypt (`N=32768`, `r=8`,
`p=1`) and a random 128-bit salt. Every part has both ciphertext and plaintext SHA-256
checksums. File names and the export identifier are authenticated as additional data.

Export holds one read-only, repeatable-read Postgres transaction from owner password
verification through the final manifest. All tables therefore share one snapshot even if
an import commits concurrently. The manifest records the exact schema, source revision,
calculation rule versions, table counts and ledger control totals.

The backup includes household identities and memberships, dimensions, ownership,
confirmed import batches, source rows, event/source links, ledger events and postings,
statement observations, reconciliation history and the source revision. It deliberately
excludes:

- password hashes, sessions, recovery codes, reset tokens and invitation tokens;
- authentication throttles and security audit history;
- database/provider credentials and environment variables;
- outbox delivery attempts, calculation candidates and published report generations.

Those exclusions prevent an old backup from restoring live access tokens or stale derived
state. User names, email addresses and financial source payloads remain sensitive and are
protected by the backup passphrase.

## Create and verify a backup

Use the administration checkout whose `.env.local` or `.env.deploy.local` contains the
matching `DATABASE_ADMIN_URL`, restricted `DATABASE_URL` and `AUTH_SECRET`. Load the
private hosted deployment environment before operating on a hosted installation.

```bash
npm run backup:export -- backups/2026-10-01
npm run backup:verify -- backups/2026-10-01
```

For the hosted installation, use `npm run backup:export:deploy -- backups/2026-10-01`.
That variant explicitly loads `.env.deploy.local`; the ordinary command uses the local
development environment. Verification needs no database or application secrets.

The export asks for an active owner's current password and a separate backup passphrase.
Neither value is accepted as a command-line argument or logged. The destination must not
already exist. Missing parent folders are created automatically. Files and newly created
directories use owner-only permissions, and
`/backups` is Git-ignored.

Create a backup after every material import or correction. Keep at least two verified
copies on storage controlled by the household, with one copy separate from the
administration computer. A forgotten passphrase cannot be recovered. Deleting the
database does not delete local copies, and deleting a local copy does not affect the
database.

## Restore drill

Restore only into a new empty database. Create the same restricted runtime and worker roles
used by a normal installation, point the private environment variables at the empty target,
then run:

```bash
npm run backup:restore -- backups/2026-10-01
```

Use `backup:restore:deploy` when the empty target configuration is stored in
`.env.deploy.local`.

The command applies the reviewed migrations, verifies and decrypts every part before any
write, and requires an email belonging to an active owner in the backup. It replaces all
credential hashes: the selected owner receives the new password and fresh one-time recovery
codes; other restored members cannot sign in until the owner issues a reset link. No old
session or recovery secret remains valid.

Restore refuses a non-empty database. It inserts the original household, membership,
dimension, source and ledger identifiers, validates row counts, source revision and balanced
posting totals, and commits atomically. Derived report and workflow history is not copied.
Instead, one bounded pending rebuild is created from the retained imports. Review provider
usage, run `npm run workflows:prepare`, renew capacity, dispatch the queued work and wait for
a new complete report release before using the dashboard.

Compare the restored installation with the source backup manifest and verify login,
recovery codes, account/source counts, reconciliation state and published totals. Perform
this drill before treating a backup set as the only recovery copy.

## Retention and deletion

Authoritative confirmed financial history and source provenance have no automatic deletion
policy. Corrections remain append-only. The application may clean only the bounded derived
generations and terminal workflow payloads described in the reporting contract.

There is no in-app household deletion in the bank milestone. Before permanently deleting an
installation, create and verify a final export, revoke provider credentials, delete the
Neon/Vercel/Inngest projects using their own controls, and separately delete every local
backup copy when the household's retention decision permits. Provider deletion and local
file erasure are deliberate operator actions; the application never performs them to free
capacity or trigger a paid upgrade.

## Local resource measurement

The 2026-10-01 PostgreSQL 18 integration drill included the 5,000-row import boundary plus
the correction, backdated calculation, report and restore fixtures: 19 batches, 5,047 source
rows, 5,015 events and 10,030 postings. The disposable database occupied 32,020,159 bytes;
core/operational tables and indexes occupied 14,991,360 bytes, while candidate/reporting
tables and indexes occupied 401,408 bytes. Four calculation runs retained 1,434 cumulative
attempts. The final 75-case identity/import/workflow/report/restore file completed in 106.43 seconds
on the local runner, including a fresh isolated database migration and restore.

These numbers demonstrate local application headroom; they do not establish Vercel, Neon or
Inngest free-plan usage. Before hosted imports, inspect all three provider dashboards and use
the guided capacity command to record a short lease. `/status` displays the resulting local
counters without polling provider APIs. It checks both lease expiries, remaining import and
calculation allowances, and calculation storage headroom. Final import admission separately
reserves the space required for the specific uploaded statement.

The restore regression also processes the restored queue through planning, bank calculations,
balance reconciliation and publication using the restricted worker role. It compares the new
report with the source at the same as-of date: account balances and unknown reasons, net worth,
income, expenses, categories, trends and cash flow.
