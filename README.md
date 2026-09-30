# networth

**A private, self-hosted household finance tracker built around reviewed CSV imports.**

Import standardized bank transactions, check every row, classify income and expenses,
and publish a consistent household dashboard. Financial records are written only after
explicit confirmation. Money calculations use exact decimals from CSV through reports.

[![Node.js 22](https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-7C3AED.svg)](LICENSE)

> [!IMPORTANT]
> This is a bank-account MVP. Bank imports, categories, reconciliation, trends, cash
> flow, account balances, and activity drilldowns work. Cards, investments, SGBs,
> loans, portfolio performance, automatic statement parsing, and bank connections are
> separate future contracts. Application-level backup and restore is also still planned;
> establish and test a database backup before storing irreplaceable records.

## What it does

- Keeps registration closed: the installer creates the first owner, then owners invite
  household members as viewers or editors.
- Accepts a versioned `bank-v1` CSV instead of uploading a raw bank statement.
- Lets an editor review statement coverage, account assignment, categories, transfers,
  possible duplicates, and reconciliation evidence before confirmation.
- Classifies income and expenses into defined categories such as Grocery, Fees & charges,
  Entertainment, Salary, and Uncategorized.
- Commits source evidence, a balanced ledger, and durable workflow intent atomically.
- Recalculates bounded pages through Inngest and publishes a complete report release.
- Shows net worth from reconciled INR bank/cash balances, monthly income and expenses,
  cash flow, largest expenses, account details, and source-linked activity.
- Preserves unknown or incomplete data instead of inventing balances, FX values, cost
  basis, historical flows, or returns.

```mermaid
flowchart LR
    A[Standardized bank CSV] --> B[Private browser review]
    B -->|Explicit confirmation| C[(Postgres evidence + ledger)]
    C --> D[Transactional outbox]
    D --> E[Bounded Inngest calculation]
    E --> F[Atomic report release]
    F --> G[Household dashboard]
```

## Current scope

| Area | Available now | Planned |
| --- | --- | --- |
| Access | Owner bootstrap, invites, roles, recovery codes, revocable sessions | External identity providers |
| Import | Reviewed `bank-v1` CSV, exact retry detection, duplicate warnings | Raw statement parsing and bank integrations |
| Classification | Defined income/expense categories and Uncategorized | Automatic categorization rules |
| Accounts | Bank and cash accounts, INR and evidenced foreign-currency book values | Cards, deposits, loans, investments, SGBs |
| Reports | Overview, accounts, activity, 12-month trends, cash flow, reconciliation states | Portfolio allocation, returns, tax and liability reports |
| Operations | Idempotent workflows, daily recovery cron, bounded provider capacity | Application-managed backup and restore |

Transfers, card repayments, investment principal, and opening balances are intentionally
excluded from ordinary expenses. Statement balances are reconciliation evidence and are
never counted as additional assets.

## Deploy to Vercel

The reference deployment uses [Vercel](https://vercel.com/) for the web app,
[Neon](https://neon.com/) for Postgres, and [Inngest](https://www.inngest.com/) for
durable recalculation. Each service currently offers a free plan, but allowances and
terms can change. Review the current limits before enabling imports. The project never
upgrades a plan or purchases capacity automatically.

### Guided setup (recommended)

The guided installer keeps the separate runtime, worker, and administrator database
identities while hiding their SQL and password generation from the normal setup path.
You need Node.js 22, a Neon database, a Vercel project, and an Inngest account.

1. Fork this repository, clone your fork, and install the locked dependencies:

   ```bash
   git clone https://github.com/YOUR_GITHUB_USER/networth.git
   cd networth
   nvm install
   nvm use
   npm ci
   ```

2. Choose the Vercel project name so you know its production URL. In Neon, create a
   project and copy its database-owner **direct** connection URL, then run:

   ```bash
   npm run deploy:prepare
   ```

   Enter the Neon URL at the hidden prompt and the final Vercel production URL when
   requested. The command enforces `sslmode=verify-full`, creates two restricted logins,
   generates independent secrets, applies the reviewed schema, grants the worker role,
   and writes `.env.deploy.local`. It never prints a credential and will not overwrite
   an existing private configuration. If you are intentionally recovering a failed
   earlier setup whose database roles already exist, use
   `npm run deploy:prepare -- --rotate`. If Vercel later assigns a different domain,
   update `APP_URL` in the private file and in Vercel before opening `/setup`.

3. Import your fork into Vercel. Add the non-empty values from `.env.deploy.local` to
   the **Production** environment and deploy. Leave the three blank Inngest values out;
   the integration adds them later. Do not add these values to Preview.

4. Open `https://YOUR_APP/setup`, enter the generated `BOOTSTRAP_SECRET`, and create the
   first owner. Save all eight recovery codes.

5. Connect the project through Inngest's official Vercel integration and redeploy. Then
   inspect the Neon, Vercel, and Inngest usage dashboards. When every account is below
   the 80% threshold, enable a conservative 24-hour import allowance:

   ```bash
   npm run deploy:enable -- personal
   ```

   `personal` allows 10 imports and 500 bounded calculation attempts. Use `regular` for
   up to 30 imports and 1,500 attempts after confirming that the larger allowance fits
   the provider capacity you actually observed. Neither preset purchases capacity or
   renews itself.

6. Check the completed installation:

   ```bash
   npm run deploy:check
   ```

   The checker verifies the live app and Inngest endpoint, migration records, first-owner
   setup, database-role separation, and the current capacity lease without printing
   secrets.

7. Remove `DATABASE_ADMIN_URL` and `BOOTSTRAP_SECRET` from Vercel Production and redeploy.
   Keep `.env.deploy.local` only on the trusted administration computer for upgrades,
   recovery, and future capacity reviews.

The remaining section documents every underlying step for operators who need custom role
names, custom capacity budgets, or manual recovery.

### Manual setup (advanced)

You need:

- a GitHub account and your own fork or copy of this repository;
- Vercel, Neon, and Inngest accounts;
- a trusted computer with Git, Node.js 22, npm 10, `psql`, and OpenSSL;
- a password manager for database URLs, secrets, and recovery codes.

### 1. Fork the repository

Use GitHub's **Fork** button, then clone your fork on the trusted computer you will use
for administration:

```bash
git clone https://github.com/YOUR_GITHUB_USER/networth.git
cd networth
nvm install
nvm use
npm ci
```

Do not commit `.env.local`, financial CSV files, database dumps, recovery codes, or
provider credentials.

### 2. Create the Neon database and restricted roles

Create a Neon project and keep its default database. You will use three independent
connections to that same database:

| Variable | Database identity | Purpose |
| --- | --- | --- |
| `DATABASE_ADMIN_URL` | Neon database/schema owner | Initial setup, migrations, worker grants, and recovery only |
| `DATABASE_URL` | `networth_app` restricted login | Normal authenticated web requests |
| `DATABASE_WORKER_URL` | `networth_jobs` restricted login | Bounded background calculations |

Copy the owner's **direct** connection string from Neon. Connect as that owner without
putting the URL into shell history:

```bash
read -rsp "Neon admin URL: " DATABASE_ADMIN_URL
export DATABASE_ADMIN_URL
psql "$DATABASE_ADMIN_URL"
```

Create the two hosted login roles in `psql`:

```sql
CREATE ROLE networth_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE ROLE networth_jobs
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

\password networth_app
\password networth_jobs
```

Generate different strong passwords at the two interactive prompts. Check the result:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
FROM pg_roles
WHERE rolname IN ('networth_app', 'networth_jobs');
```

Every boolean column should be `false`. Exit with `\q`. Use Neon's connection dialog,
select each new role, and copy its connection string. A pooled connection is suitable
for `DATABASE_URL` and `DATABASE_WORKER_URL`; keep the direct owner connection for
`DATABASE_ADMIN_URL`.

All three hosted URLs must target the same database and use TLS verification:

```text
?sslmode=verify-full
```

Add the parameter with `?` when it is the first query parameter, or with `&` when other
parameters are present. If the URL already contains `sslmode`, replace its value instead
of adding a second copy. Do not use the Neon owner connection as the runtime or worker
connection. The migrations create an internal NOLOGIN role named `networth_worker`, so
do not use that name for the hosted worker login.

See [Neon's Vercel connection guide](https://neon.com/docs/guides/vercel-manual),
[Neon's role distinction](https://neon.com/docs/changelog/2023-12-23), and
[PostgreSQL role membership](https://www.postgresql.org/docs/current/role-membership.html).

### 3. Generate application secrets

Generate three independent values and save them in your password manager:

```bash
openssl rand -hex 32  # AUTH_SECRET
openssl rand -hex 32  # BOOTSTRAP_SECRET
openssl rand -hex 32  # CRON_SECRET
```

- `AUTH_SECRET` encrypts authentication state.
- `BOOTSTRAP_SECRET` authorizes the one-time first-owner setup.
- `CRON_SECRET` authorizes Vercel's daily recovery request.

Never reuse a database password for any of these values.

### 4. Create the Vercel project

After the Neon roles and secrets are ready, use the button below or import your fork
from Vercel's **New Project** screen.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Favirup%2Fnetworth&env=DATABASE_URL%2CDATABASE_ADMIN_URL%2CDATABASE_WORKER_URL%2CAUTH_SECRET%2CBOOTSTRAP_SECRET%2CCRON_SECRET%2CAPP_URL)

Choose the project name before entering `APP_URL`; its value must be the exact final
HTTPS origin with no trailing path, query, or fragment, for example:

```text
https://your-networth-project.vercel.app
```

If Vercel assigns a different production domain, update `APP_URL` to that domain and
redeploy before opening `/setup`.

Add these variables to the **Production** environment only:

| Variable | Initial value | Keep in the web deployment? |
| --- | --- | --- |
| `DATABASE_URL` | Restricted `networth_app` URL | Yes |
| `DATABASE_ADMIN_URL` | Direct Neon owner URL | Remove after first-owner setup |
| `DATABASE_WORKER_URL` | Restricted `networth_jobs` URL | Yes |
| `AUTH_SECRET` | First generated secret | Yes |
| `BOOTSTRAP_SECRET` | Second generated secret | Remove after first-owner setup |
| `CRON_SECRET` | Third generated secret | Yes |
| `APP_URL` | Exact production HTTPS origin | Yes |

Do not configure `INNGEST_DEV`, `LOCAL_RUNTIME`, `LOCAL_UI_PREVIEW`, or
`TEST_DATABASE_URL` on Vercel. Do not expose any server variable with a
`NEXT_PUBLIC_` prefix. Preview deployments deliberately refuse database, login, and
workflow operations even if credentials are accidentally assigned to them.

Deploy the project. Vercel reads `vercel.json` and installs a daily
`/api/workflows/recover` cron. When `CRON_SECRET` is configured, Vercel sends it as the
Bearer authorization value. Environment changes affect only new deployments, so use
**Redeploy** after changing variables. See Vercel's official guides for
[Git deployments](https://vercel.com/docs/git),
[environment variables](https://vercel.com/docs/environment-variables), and
[cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

### 5. Create the first owner

Open this route on the production deployment:

```text
https://your-networth-project.vercel.app/setup
```

Enter `BOOTSTRAP_SECRET`, your owner email, and a strong password. Setup applies the
versioned migrations and creates the installation, first household, and first owner in
one transaction. Save all eight recovery codes before continuing. The bootstrap route
cannot replace an existing owner or run a second time.

If setup fails, inspect the Vercel function log and verify that the direct admin URL is
reachable, targets the same database as the other connections, includes
`sslmode=verify-full`, and has permission to create roles and schemas.

### 6. Connect Inngest

In Inngest, install the official Vercel integration and connect this Vercel project.
It adds production `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` variables and syncs the
app after a deployment. Redeploy if the integration does not trigger one automatically.
The serving endpoint is:

```text
https://your-networth-project.vercel.app/api/inngest
```

Confirm in Inngest that the app and its functions are registered. Keep signing and
event keys secret. `INNGEST_SIGNING_KEY_FALLBACK` is needed only during a deliberate
key rotation. See Inngest's official
[Vercel deployment guide](https://www.inngest.com/docs/deploy/vercel),
[signing-key guide](https://www.inngest.com/docs/platform/signing-keys), and
[event-key guide](https://www.inngest.com/docs/events/creating-an-event-key).

### 7. Prepare the worker

On your trusted local checkout, create an owner-readable `.env.local` containing the
production values. This file is Git-ignored:

```dotenv
DATABASE_URL=postgresql://networth_app:...@.../...?sslmode=verify-full
DATABASE_ADMIN_URL=postgresql://owner:...@.../...?sslmode=verify-full
DATABASE_WORKER_URL=postgresql://networth_jobs:...@.../...?sslmode=verify-full
AUTH_SECRET=...
BOOTSTRAP_SECRET=...
CRON_SECRET=...
APP_URL=https://your-networth-project.vercel.app
INNGEST_EVENT_KEY=...
INNGEST_SIGNING_KEY=...
```

Restrict the file, then grant the worker only the reviewed capabilities:

```bash
chmod 600 .env.local
npm run workflows:prepare
```

The command uses `DATABASE_ADMIN_URL` to grant the restricted worker login membership
in the internal worker role. It refuses an unsuitable worker identity.

### 8. Review capacity and enable imports

The application starts with import confirmation paused. Before enabling it, manually
inspect your Neon, Vercel, and Inngest dashboards, including usage from other projects.
Stay below the documented 80% deferral threshold and reserve room for callbacks,
retries, publication, and recovery.

After that review, issue a short capacity lease from the trusted checkout:

```bash
npm run workflows:verify -- 10 500 150000000 60 "Checked Neon, Vercel and Inngest dashboards"
```

The positional values are:

1. remaining imports;
2. remaining calculation attempts;
3. remaining derived-storage bytes;
4. lease duration in minutes;
5. an audit reason.

The example values are ceilings, not a recommendation. Reduce them to the capacity you
actually verified. The command does not contact providers, infer headroom, or buy
capacity. When the lease expires or a budget is exhausted, new work pauses while the
last published report and authoritative financial history remain intact. Review usage
again before renewing it.

### 9. Remove bootstrap privileges

After setup and worker preparation succeed:

1. remove `BOOTSTRAP_SECRET` and `DATABASE_ADMIN_URL` from Vercel's Production variables;
2. keep both values privately on the trusted administration computer for upgrades and
   sole-owner recovery;
3. redeploy so the removal reaches the running application.

The web app should retain only the restricted runtime and worker database connections.

### 10. Verify the deployment

Check these routes and actions:

1. `GET /api/health` returns liveness without exposing private configuration.
2. `GET /api/health/ready` becomes ready after schema, Inngest, worker, and lease checks
   agree. A `503` before completing those steps is expected.
3. Sign in at `/login`, open `/status`, and verify the installation state.
4. Create a member invitation and open it in a private browser window.
5. Download the synthetic example from `/templates/bank-v1-example.csv`.
6. Import it into a test bank account, review every row, confirm it, and verify that a
   published release appears in Overview, Accounts, and Activity.
7. Inspect the Vercel, Neon, and Inngest logs and usage dashboards. Logs must not contain
   connection strings, tokens, raw CSV contents, or complete account identifiers.

Do this synthetic end-to-end check before importing personal records.

## Updating an installation

Pull reviewed changes on the trusted checkout and install exactly the locked packages:

```bash
git pull --ff-only
nvm use
npm ci
```

Back up the database, restore that backup into a separate database, and test it before
upgrading. Make `DATABASE_ADMIN_URL` available only on the trusted computer, then run:

```bash
npm run db:migrate
```

This command upgrades an existing completed installation. Fresh installations use
`/setup` instead. No build, startup, or ordinary request applies migrations. After a
successful migration, deploy the matching application revision and repeat the hosted
verification. Never edit an already-applied migration.

## Local development

Requirements: Node 22 (see `.nvmrc`), npm 10.9.8, and Postgres 16 or newer. Docker
Compose is an optional local Postgres convenience; Docker is not required in production.

```bash
nvm use
npm ci
npm run local:setup
npm run db:up
npm run local:auth
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). In a second terminal, start the
local Inngest Dev Server:

```bash
npm run inngest:dev
```

`local:setup` creates a private, Git-ignored `.env.local` with random development
secrets and loopback database URLs. `db:up` starts only Postgres on loopback port 15432.
Run `npm run db:stop` to stop it without deleting its volume. If you already run
Postgres 16+, configure the three local roles yourself and skip Docker.

For a synthetic, read-only interface preview:

```bash
LOCAL_UI_PREVIEW=1 npm run dev
```

Then open [http://127.0.0.1:3000/preview](http://127.0.0.1:3000/preview). The preview is
disabled on Vercel and accepts no uploads.

## CSV format and categories

Download these synthetic public files from a running installation or the repository:

- [blank bank template](public/templates/bank-v1.csv);
- [example bank transactions](public/templates/bank-v1-example.csv);
- [matching statement metadata](public/templates/bank-v1-example-manifest.json);
- [foreign-currency example](public/templates/bank-v1-fx-example.csv);
- [defined category codes](public/templates/categories-v1.csv).

The exact header is:

```csv
schema_version,row_id,transaction_ref,transaction_date,description,direction,amount,currency,event_type,category,book_amount_inr,fx_rate,related_row_id
```

Use a category **code** from `categories-v1.csv`, such as `grocery`, `fees`,
`entertainment`, or `salary`. A blank category remains Uncategorized. Unknown codes and
income/expense mismatches are rejected. The import screen also supports individual and
bulk category assignment during review.

`bank-v1` represents cash movement in a bank account. It does not pretend that a net
bank debit contains enough detail to model a card purchase, security trade, SGB holding,
loan split, corporate action, or tax lot. Those products require their own evidence and
templates. See [the complete bank CSV contract](docs/bank-csv-v1.md) and
[the reviewed import workflow](docs/bank-imports.md).

## Verification

Stop the development server before running the full checks:

```bash
npm run check
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run test:e2e:auth
node scripts/check-client-secrets.mjs
```

`npm run check` runs lint, generated-route type checking, unit tests, and a production
build. Integration and authenticated browser tests require the local disposable
`networth_test` database and recreate its `core` schema. Never point their
`TEST_DATABASE_URL` at real records. See [authentication operations](docs/authentication.md),
[workflow delivery](docs/workflow-delivery.md), and
[report publication](docs/report-publication.md) for deeper operational checks.

## Troubleshooting

**`Administration failed. Verify configuration...`**

The administrative commands deliberately hide database details. Check that `.env.local`
contains the direct `DATABASE_ADMIN_URL`, the database is reachable, TLS verification is
enabled when hosted, and `/setup` has completed. `npm run db:migrate` is for an existing
installation; use `/setup` for a new one.

**Readiness returns `503`.**

Finish the migration/setup, connect Inngest, run `workflows:prepare`, and issue a current
capacity lease after checking provider usage. Readiness fails closed if any requirement
is missing or expired.

**Login or setup does not work on a preview URL.**

That is deliberate. Use the exact Production `APP_URL`; preview deployments cannot access
authentication, database, import, or workflow operations.

**A changed environment variable has no effect.**

Redeploy the Vercel project. Variable changes apply to new deployments, not an already
running deployment.

**A confirmed import is waiting.**

Inspect Inngest delivery and function runs, the worker connection, the capacity lease,
and provider usage. Retry or resume through the authenticated owner controls. Do not
modify confirmed ledger rows directly.

## Security and privacy

- No hosted AI, analytics, raw-statement parser, bank integration, or automatic upgrade.
- No credentials, provider tokens, real financial fixtures, or raw import payloads in Git.
- Household membership is checked on every protected server operation; Postgres RLS is a
  second isolation boundary.
- Confirmed ledger events are append-only and balanced. Corrections use traceable reversal
  and replacement events.
- API money values are decimal strings. Authoritative arithmetic never uses JavaScript
  floating point.
- Provider capacity is reviewed and leased explicitly. Insufficient capacity pauses work
  instead of deleting financial history or silently exceeding a free-plan target.

Read [the architecture boundaries](docs/architecture.md),
[live-report behavior](docs/live-bank-reports.md), and [project instructions](AGENTS.md)
before making structural changes.

## License

[MIT](LICENSE)
