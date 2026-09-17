# Runtime foundation

Steps 1–3 provide the runtime, shared UI, owner setup, authentication and household
authorization. Financial imports, ledger calculations and reports are the next phases.
See [installation and authentication](authentication.md) for operational details.

## Boundaries

| Directory | Responsibility |
| --- | --- |
| `app/` | App Router pages and HTTP endpoints; call domain/query modules rather than implementing accounting |
| `components/` | Shared accessible UI, introduced in Step 2 |
| `db/schema/`, `db/migrations/` | Reviewed typed schema and versioned migrations, introduced in Step 3 |
| `db/queries/` | Database access, scoped operational/reporting queries |
| `lib/config/` | Server-only configuration, safe diagnostics and fail-closed deployment/schema policy |
| `lib/auth/` | Credential validation, password/token primitives and protected request boundaries |
| `db/auth/` | Atomic identity workflows, scoped authorization and reviewed migration runner |
| `lib/validation/`, `lib/imports/` | Versioned CSV validation, review/confirmation and provenance |
| `lib/calculations/` | Decimal accounting, lots, valuations and returns; no UI/workflow dependencies |
| `lib/reporting/` | Shared metric/release/query contracts |
| `inngest/` | Bounded orchestration; no registered jobs in Step 1 |
| `tests/` | Unit, real-Postgres compatibility tests and browser smoke checks |

## Configuration and deployment safety

Environment variables are validated without logging their values. Bootstrap secrets
are optional after setup; setup requires a valid one before any database access or mutation.
Hosted database connections require `sslmode=verify-full`; do not bypass certificate
verification. Production origins must use HTTPS. Local Inngest mode is rejected in
hosted contexts, and all preview/unknown hosted contexts deny database access and jobs.

`GET /api/health` is liveness only and does not access services. Explicit readiness
at `/api/health/ready` returns generic `503 {"status":"not_ready"}` until installation,
schema, configuration and verified workflows are ready. It never applies migrations.
The current phase intentionally cannot report financial readiness. Operator startup diagnostics
identify missing/invalid variable names; the public HTTP response does not.

The schema compatibility gate accepts version 1 only. Missing, invalid, older or
newer versions refuse application operations; an authenticated owner retains limited
status access if the identity contract remains readable. Setup and local upgrade commands
apply checksummed migrations under a shared advisory lock. No startup migration runs.

The local Inngest endpoint registers an empty function list. Hosted GET/POST/PUT
are disabled until signed-handler tests and real workflow authorization exist in Step 6.
No cron, schedule, keep-alive or background recalculation is deployed.

The runtime login is distinct from the migration administrator. Verified queries use
transaction-local role, membership and session context with FORCE RLS. Local preparation
creates a restricted runtime login; the Compose administrator is not used for ordinary
application operations. Future workers receive separate scoped grants.

See [the authentication compatibility decision](decisions/0001-auth-session-compatibility.md)
for the adopted session-registry protocol. No tracked build/runtime file depends on private planning
documents, ignored UI mockups, fonts from those mockups, or design-tool metadata.

## Dependency choices

Node 22 and npm 10 are the selected local/runtime toolchain. Dependencies are exact
and the lockfile defines the resolved tree. Development and production builds use
Next.js's supported Webpack option because Turbopack's internal CSS-worker port
binding failed in the local execution sandbox. Auth.js v5 is explicitly pinned to a beta
with Next.js 16 peer support; its credentials behavior is regression-tested before
application use. Decimal.js, Drizzle and Inngest are installed for their foundation
boundaries. UI components, CSV/table/chart packages and forecast tools are added at
their implementation steps rather than installing every future module now.

Next.js automatic agent-rule generation is disabled (`agentRules: false`) so running
the development server preserves the project's authored `AGENTS.md`.

Vite 7.3.6 is explicitly pinned within Vitest 4's supported range. The automatically
selected Vite 8 toolchain triggered npm 10 peer-resolution failures; a lock generated
with npm 12 also included platform-specific extraneous entries that npm 10 could not
install. Generate and verify the project lock with the documented npm 10 toolchain.

Two narrow development-tool overrides patch transitive dependencies: the legacy
Drizzle loader's esbuild is pinned to 0.25.12 and Inngest CLI's adm-zip to 0.6.1.
Verify Drizzle generation and CLI startup after changing these overrides; remove them
when upstream packages incorporate compatible fixes. Do not apply an audit fix that
downgrades the selected tools to unrelated older releases.

Technical references:

- [Next.js manual installation](https://nextjs.org/docs/app/getting-started/installation)
- [Inngest local development](https://www.inngest.com/docs/local-development)
