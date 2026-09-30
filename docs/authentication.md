# Installation and household access

Phase 3 implements closed registration, owner bootstrap, invitations, recovery,
revocable sessions, household permissions and Postgres isolation. Financial uploads,
bank report reads and signed Inngest jobs require schema 10 plus a reviewed capacity lease.

## Local installation

Use Node 22 and the committed npm lockfile. Docker is an optional convenience for
local Postgres, not an application or hosting dependency.

```sh
npm ci
npm run local:setup
npm run db:up
npm run local:auth
npm run dev
```

`local:auth` creates a restricted login in the supplied loopback Compose instance.
For an older generated `.env.local`, it changes only the recognized Compose database
connection fields and preserves existing secrets. It refuses other configurations.
With your own Postgres 16+ instance, skip Compose and create the roles below yourself.

Open `/setup`, enter your private `BOOTSTRAP_SECRET` from `.env.local`, and create
your owner account. Save the eight recovery codes and acknowledge them before
continuing to sign-in. Nothing creates an account automatically. After setup, remove
`BOOTSTRAP_SECRET` and `DATABASE_ADMIN_URL` from the running web deployment; keep the
admin connection privately for upgrades/recovery. Restart after environment changes.

## Database connections

Use independent connections to the **same database**:

- `DATABASE_ADMIN_URL`: database/schema owner with permission to create roles and
  grant membership. Only authorized initial setup and local administration use it.
  Use a direct connection for migrations.
- `DATABASE_URL`: a separate LOGIN role, without SUPERUSER, BYPASSRLS, CREATEDB or
  CREATEROLE, and without ownership of application tables. Never grant it admin
  membership. The migration grants only the identity/member capabilities it needs.

Create a restricted runtime role using SQL as your database administrator:

```sql
CREATE ROLE networth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
```

Set its independent password using `psql`'s interactive `\password networth_app`
prompt or an equivalent private administrative interface. Do not place passwords in
shell history, repository files or screenshots. Use its connection as `DATABASE_URL`.
The local helper's documented development passwords must never be used when hosted.

The migration creates NOLOGIN `networth_auth`, `networth_member` and `networth_worker`
roles. Ordinary connections inherit no table privileges. Identity transactions
explicitly assume `networth_auth`. Financial query entry points must use
`identity().scoped(...)`: it resolves the registry and active membership, installs
transaction-local user/household/session settings, then assumes `networth_member`.
RLS independently verifies those settings against the live session. Pool reuse clears
both role and settings at transaction end. The worker role has no data grants and
cannot be assumed by the runtime login; Phase 6 provisions only bounded worker functions.
The privileged identity service is a trusted server boundary, not a general query API.

All identity tables use FORCE RLS. Scoped invitation/reset/audit foreign keys prevent
cross-household references. Owner invariants serialize on the household row and lock
the affected identity; direct concurrent SQL cannot remove the final active owner.
Security history and completed setup are immutable through application roles.

Neon roles created through its console/API can carry elevated membership; create the
runtime role with SQL and inspect its grants rather than treating a newly created
console role as restricted. See [Neon's role distinction](https://neon.com/docs/changelog/2023-12-23)
and [Postgres role membership](https://www.postgresql.org/docs/16/role-membership.html).
Hosted provisioning and native password hashing still require verification on the
installer's actual runtime; local tests do not establish hosted readiness or capacity.

## Manual hosted configuration

For a new installation, the recommended path is the repository-root guided command:

```sh
npm run deploy:prepare
```

It prompts privately for the direct Neon owner URL and exact production origin, creates
the restricted `networth_app` and `networth_jobs` logins, generates independent secrets,
applies the reviewed schema, prepares the worker, and writes the Git-ignored
`.env.deploy.local`. It does not contact Vercel, create an owner, enable imports, overwrite
an existing private configuration, or print credentials. Add the generated values to
Vercel Production, complete `/setup`, connect Inngest, and follow the guided README steps.
The manual procedure below remains the recovery and custom-installation reference.

Import your own copy of this repository into your personal Vercel project and provision
your own Neon database. Configure the two connections above with `sslmode=verify-full`,
independent random `AUTH_SECRET` and `BOOTSTRAP_SECRET` values of at least 32 characters,
and the exact HTTPS `APP_URL`. Keep all values server-only. Deploy, complete `/setup`,
then remove bootstrap/admin credentials from the web environment and redeploy.
Missing Inngest keys do not block owner setup or account access. They do block financial
readiness; adding keys alone cannot enable an unimplemented financial endpoint.
Preview deployments always refuse database/authentication operations.

For a production build on your own computer, `LOCAL_RUNTIME=1` permits HTTP only when
both APP_URL and Postgres use loopback and no Vercel environment is present. This is
not a hosted bypass. The usual `npm run dev` needs no such flag.

## Sessions and security actions

Auth.js credentials use encrypted, HTTP-only, same-site cookies; HTTPS sets Secure.
Each sign-in creates a random reference, storing only SHA-256 in Postgres. Registry
expiry is absolute at 24 hours; at most ten live sessions per user are retained.
Every protected operation resolves current membership. Roles never come from cookies,
and the session JSON never includes the bearer reference. See the
[compatibility decision](decisions/0001-auth-session-compatibility.md).

Owners manage members, invitations and installation status. Editors can read, import
and classify; viewers can read. Raw export is owner-only. All financial operations
remain unavailable in this phase. Users can manage their own password/recovery and
sessions. Security changes require a password confirmation no older than five minutes.
Password changes, recovery, code replacement and membership changes revoke sessions.
Promoting an owner is a separate owner action; invitations cannot grant ownership.

Invitation tokens are random 256-bit values, keyed-hashed, email-bound, single-use and
valid for 24 hours. At most 50 live invitations are allowed per household. Existing
identities must prove their existing password when accepting another invitation.
Member reset links last 30 minutes and cannot reset an owner. Creator removal or
loss of owner permission invalidates their pending invitations/reset authority.
Recovery codes contain 128 random bits, are keyed-hashed, expire after one year and
are consumed in the same transaction as the password update and session revocation.
Only the initial response contains raw codes/links. Save them privately.

Generated invitation/reset links use URL **fragments** (`/invite#token=...` and
`/recover#token=...`) so the token is absent from HTTP paths, server access logs and
referrers. The client submits it in the bounded POST body and clears it after success.
No analytics or external delivery service is used.

State-changing JSON APIs require the canonical Host and Origin, JSON content type,
and a body no larger than 32 KiB. Auth.js adds its own CSRF token checks. Auth requests
are rebuilt using the configured canonical origin; forwarded host headers cannot
choose the trust boundary. Errors never serialize database details or request inputs.
Login/recovery/invite acceptance/password confirmation use 15-minute Postgres buckets:
10 per account, 30 per coarse shared source, 100 globally, with at most 4,096 buckets
and bounded expired-row cleanup. This installation deliberately treats source as shared
rather than trusting spoofable proxy IP headers. All attempts count, including successes.

A wrong bootstrap secret is rejected with a timing-safe comparison **before any
Postgres access or password hashing**. It cannot mutate a database throttle bucket;
the high-entropy secret is the pre-database authorization boundary. Authorized setup
is advisory-locked, bounded and atomic, including migration history and recovery codes.
Bootstrap reuse returns a conflict and never replaces an owner.

## Upgrades and sole-owner recovery

Migrations are versioned SQL with recorded SHA-256 checksums. No build/startup request
runs migrations. A failed setup rolls back schemas, evidence and owner creation together.
Do not edit an applied migration; add a new forward migration and compatibility range.
Run reviewed upgrades from a trusted local checkout with private connection settings:

```sh
npm run db:migrate
```

This requires an existing completed installation. Concurrent setup/upgrades share an
advisory lock. Unknown or modified applied migrations are rejected. Incompatible
schema versions block application operations while an authenticated owner can inspect
`/status`, provided the identity tables retain the established contract. Structural
incompatibility fails closed and requires local administration.

If the **sole active owner** loses their password and all recovery codes:

```sh
npm run auth:recover-owner
```

The command requires an interactive terminal, admin connection, exact installation UUID
and matching sole-owner email. The new password is hidden and never passed as a command
argument. Recovery is atomic, audited, and invalidates sessions, codes, reset links and
pending invitations created by that owner. It cannot reopen bootstrap, choose a new
owner, or bypass a multi-owner household. Sign in and regenerate recovery codes.
Administrators can inspect the installation UUID directly in their own database:
`SELECT id FROM core.system_installation;`.

## Verification

```sh
npm run check
npm run test:integration
npm run test:e2e
npm run test:e2e:auth
node scripts/check-client-secrets.mjs
```

Integration and authenticated browser tests **drop/recreate `core` only in the explicitly
configured loopback database named `networth_test`**. Never put real records there; do
not run those two suites concurrently. Auth compatibility tests use their own unique
schemas. Auth browser checks start an isolated server on port 3102 and use synthetic
credentials. Existing preview/missing-config checks use 3100/3101. Screenshots/traces
remain ignored. Firefox can be selected with `PLAYWRIGHT_BROWSER=firefox`.
