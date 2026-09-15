# Runtime foundation

This repository is currently at implementation Step 1. It has a runnable Next.js
application and local verification tools, but no owner setup, working sign-in,
financial imports, ledger or reporting dashboard yet.

## Boundaries

| Directory | Responsibility |
| --- | --- |
| `app/` | App Router pages and HTTP endpoints; call domain/query modules rather than implementing accounting |
| `components/` | Shared accessible UI, introduced in Step 2 |
| `db/schema/`, `db/migrations/` | Reviewed typed schema and versioned migrations, introduced in Step 3 |
| `db/queries/` | Database access, scoped operational/reporting queries |
| `lib/config/` | Server-only configuration, safe diagnostics and fail-closed deployment/schema policy |
| `lib/auth/` | Server-only authentication primitives; password hashing now, full auth later |
| `lib/validation/`, `lib/imports/` | Versioned CSV validation, review/confirmation and provenance |
| `lib/calculations/` | Decimal accounting, lots, valuations and returns; no UI/workflow dependencies |
| `lib/reporting/` | Shared metric/release/query contracts |
| `inngest/` | Bounded orchestration; no registered jobs in Step 1 |
| `tests/` | Unit, real-Postgres compatibility tests and browser smoke checks |

## Configuration and deployment safety

Environment variables are validated without logging their values. Bootstrap secrets
are optional after setup; future setup must require a valid one before any mutation.
Hosted database connections require `sslmode=verify-full`; do not bypass certificate
verification. Production origins must use HTTPS. Local Inngest mode is rejected in
hosted contexts, and all preview/unknown hosted contexts deny database access and jobs.

`GET /api/health` is liveness only and does not access services. Explicit readiness
at `/api/health/ready` returns generic `503 {"status":"not_ready"}` until installation,
schema, configuration and verified workflows are ready. It never applies migrations.
Step 1 intentionally cannot report financial readiness. Operator startup diagnostics
identify missing/invalid variable names; the public HTTP response does not.

The schema compatibility gate accepts version 1 only. Missing, invalid, older or
newer versions refuse financial writes. Step 3 owns the actual singleton installation
schema and migration runner. No automatic migrate/push command exists in this scaffold.

The local Inngest endpoint registers an empty function list. Hosted GET/POST/PUT
are disabled until signed-handler tests and real workflow authorization exist in Step 6.
No cron, schedule, keep-alive or background recalculation is deployed.

Use a least-privilege application role and transaction-local membership/RLS context
when implementing database authorization. The local Compose role is for isolated
development only; it is not a production role model.

See [the authentication compatibility decision](decisions/0001-auth-session-compatibility.md)
before implementing login. No tracked build/runtime file depends on private planning
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
