# Manual deployment (advanced)

For most installations, use the [guided setup](../README.md#deploy-to-vercel).
This reference is for custom database roles and capacity budgets. Choose one setup path;
you do not need to repeat these steps after guided preparation.

You need:

- a GitHub account and your own fork or copy of this repository;
- Vercel, Neon, and Inngest accounts;
- a trusted computer with Git, Node.js 24 LTS, npm 12, `psql`, and OpenSSL;
- a password manager for database URLs, secrets, and recovery codes.

### 1. Fork the repository

Use GitHub's **Fork** button, then clone your fork on the trusted computer you will use
for administration:

```bash
git clone https://github.com/YOUR_GITHUB_USER/networth.git
cd networth
nvm install
nvm use
npm install --global npm@12.2.0
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

Use the Next.js preset, Node.js 24.x, install command
`npm install --global npm@12.2.0 && npm ci`, and build command `npm run build`.

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
2. The public `/api/health/ready` route currently always returns `503` because its
   workflow verification flag is not wired. Use the authenticated `/status` screen
   and a successful import-to-report run to verify readiness.
3. Sign in at `/login`, open `/status`, and verify the installation state.
4. Create a member invitation and open it in a private browser window.
5. Follow the minimal CSV walkthrough linked below. The larger
   `/templates/bank-v1-example.csv` also needs a second account for its transfer row.
6. Import into a test bank account, review every row, confirm it, and verify that a
   published release appears in Overview, Accounts, and Activity.
7. Inspect the Vercel, Neon, and Inngest logs and usage dashboards. Logs must not contain
   connection strings, tokens, raw CSV contents, or complete account identifiers.

For a minimal test without transfer-account setup, follow the [first import walkthrough](../README.md#6-check-an-import-and-save-a-backup). Do this before importing personal records.
