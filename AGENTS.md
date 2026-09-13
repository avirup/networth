# Project instructions

## Product

Build a private, self-hosted household net-worth tracker.
Users upload standardized CSV files, review them, and explicitly
confirm imports before financial records are saved.

Recurring hosting must remain ₹0. No paid dependencies, automatic
upgrades, hosted AI, raw statement parsing, or bank integrations.

## Read before working

- Inspect git status and preserve unrelated changes.
- If IMPLEMENTATION_PLAN.md exists, read its current handoff.
  Use it to sequence implementation within the user's requested scope.
- Read relevant design sources when available:
  - PRODUCT.md: scope and product requirements.
  - TECH_STACK.md: technologies and resource controls.
  - DATABASE_DESIGN.md: accounting and reporting contracts.
  - SELF_HOSTING_AND_AUTH.md: installation and access control.
- These documents may be Git-ignored and absent from fresh clones.
  Use tracked documentation and code when absent. Identify missing
  decisions that materially affect the task instead of inventing them.

## Architecture

- Use the selected Next.js App Router and TypeScript stack.
- Postgres with Drizzle is the financial system of record.
- Keep domain calculations separate from UI, database access,
  workflow orchestration, and reporting presentation.
- Use Inngest for bounded, idempotent recalculation.
- Serve reports through authenticated SQL reporting APIs.
- Cube is not required for the MVP.
- Follow the existing package manager and lockfile.
- Verify compatibility before introducing or upgrading dependencies.

## Financial correctness

- Use Postgres NUMERIC, decimal strings at API boundaries, and
  decimal.js for authoritative financial arithmetic.
- Never silently coerce money to JavaScript floating-point numbers.
- Enforce balanced postings and household-scoped relationships
  in the database.
- Confirmed ledger events are append-only. Correct them through
  traceable reversals and replacements.
- Commit import evidence, ledger records, and outbox work atomically.
- Preserve source provenance and distinguish exact retries from
  ambiguous duplicates.
- Statement balances are reconciliation evidence, not extra assets.
- Transfers, investment principal, and card repayments are not
  ordinary expenses.
- Apply ownership once and avoid overlapping valuation components.
- Unknown values remain unknown with an explicit reason.
- Publish complete report releases; pin all dashboard widgets to
  the same release, authorized scope, and as-of date.
- Never invent cost basis, valuations, historical flows, or returns.

## Interface

- Preserve the current ui-mockup implementation and style guide
  when available, followed by the extracted application design tokens.
- The current reference uses single light mode, lavender surfaces,
  cobalt data accents, violet actions, and self-hosted Poppins.
- Older green-dashboard briefs and dark-mode references are stale.
- Preserve responsive navigation, the global month selector,
  tabular financial numerals, and expandable portfolio details.
- Financial contracts override illustrative mockup values/formulas.
- Include loading, empty, error, incomplete, stale, and quota-paused
  states as relevant.
- Support keyboard navigation, visible focus, reduced motion,
  and accessible chart descriptions.
- Use synthetic data only for fixtures and demonstrations.

## Security and resource limits

- Registration is closed: bootstrap the first owner, then use invites.
- Authorize every protected server operation through active household
  membership and permissions; do not rely on hidden UI controls.
- Enforce household isolation with scoped queries, keys, and RLS.
- Never commit or log credentials, tokens, real financial fixtures,
  complete account identifiers, or import payloads.
- Enforce documented import, response, storage, and workflow limits
  on the server as well as in the interface.
- Defer work when capacity is insufficient.
- Rebuild affected ranges and reuse unchanged results.
- Do not add idle polling or periodic full-history recalculation.
- Never delete authoritative financial history to reclaim capacity.

## Verification

- Discover actual commands from package scripts and tracked docs;
  do not claim unavailable checks have passed.
- Run relevant lint, typecheck, build, and tests for each change.
- Use known-answer fixtures for financial calculations.
- Use real Postgres integration tests for constraints, transactions,
  RLS, concurrency, and migrations.
- Test import review through published reports with Playwright.
- Inspect desktop and mobile layouts after meaningful UI changes.
- Test failure, retry, rollback, and incomplete-data behavior.
- Keep testing proportional; investigate failures before broadening.

## Working style and handoff

- Complete the requested scope without unrelated refactors.
- Resolve routine reversible implementation choices independently.
- Surface material conflicts with accepted design decisions.
- Keep migrations reviewed, versioned, and safe for existing data.
- Keep builds independent of ignored local planning/reference files.
- When IMPLEMENTATION_PLAN.md exists, update completed work,
  actual verification results, remaining issues, and the next action.
- Summarize what changed, how it was verified, and any limitations.
