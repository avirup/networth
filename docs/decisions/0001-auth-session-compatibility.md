# Credentials and revocable sessions

Status: compatibility candidate verified by eight real-Postgres integration tests;
no application login route is enabled. Step 3 owns production integration.

The original design specifies Auth.js credentials with a Drizzle-backed database
session strategy. The pinned `next-auth@5.0.0-beta.32` uses `@auth/core@0.41.3`,
whose configuration validator rejects credentials-only authentication with
`session.strategy = "database"` (`UnsupportedStrategy`). This is a real library
constraint, not something an adapter installation fixes.

The proposed compatible implementation uses Auth.js's supported encrypted JWT
cookie with an application-owned Postgres session registry accessed through Drizzle:

1. Verify the password server-side with Argon2id.
2. Generate a random 256-bit session reference on each sign-in.
3. Store only its SHA-256 digest, user ID, absolute expiry and revocation state.
4. Include the reference in Auth.js's encrypted, HTTP-only cookie.
5. On every server session resolution, check the registry and fail closed when it
   is absent, expired, revoked or unavailable. Do not cache this authorization check.
6. Resolve current membership separately for every protected read/write; never
   treat roles in a cookie as authorization.
7. Revoke the record on sign-out and all relevant records on reset, disabling a user,
   or security changes. Rotation requires new registry records.

The database remains authoritative for revocation. This does **not** use Auth.js's
built-in database session mode or custom JWT encoding/cookie overrides. The registry's
absolute expiry remains binding even if Auth.js refreshes the cookie expiry. The
session reference must never appear in browser-readable session JSON or logs.

`tests/integration/auth-compatibility.test.ts` exercises the real Auth.js CSRF,
credentials callback, cookie, session and sign-out protocol against an isolated
Postgres schema. It also reproduces the unsupported configuration, tests unknown
users/wrong passwords, registry persistence, new-login rotation, revocation,
expiry, registry outage and sign-out reuse. The test configuration uses synthetic
credentials and is deliberately excluded from application imports.

Step 3 must integrate this candidate with the reviewed installation/auth schema,
membership checks, secure production cookies, trusted origin/host configuration,
generic errors, rate limits, last-owner protection, audit events, invitations,
recovery and rotation rules. Recheck compatibility when upgrading the pinned beta.
Do not enable login by copying the test fixture into a route.

Argon2id parameters are 64 MiB, three passes, one lane and a 32-byte output,
with independent random salts and parameters encoded in each hash. Native behavior
is tested on local Node 22/Linux; benchmark the actual Vercel runtime before enabling
production credentials. The test does not establish hosted capacity or free-tier use.

References checked during implementation:

- [Auth.js credentials](https://authjs.dev/getting-started/providers/credentials)
- [Auth.js session strategies](https://authjs.dev/concepts/session-strategies)
- Pinned source: `node_modules/@auth/core/src/lib/utils/assert.ts` and
  `node_modules/@auth/core/src/lib/actions/{callback/index,session}.ts`.
