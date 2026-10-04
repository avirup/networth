# Application UI

The application preserves the approved light lavender dashboard reference. Runtime
styles and components are tracked; ignored mockups and planning files are never build
inputs. The working name lives in `lib/presentation/product.ts`.

## Preview and access boundaries

Run `LOCAL_UI_PREVIEW=1 npm run dev`, with `APP_URL=http://127.0.0.1:3000` in the local
environment, then visit `/preview`. The login page links to it only when enabled.
The preview requires explicit server-side opt-in and a loopback HTTP application
origin. Vercel preview and production environments always return 404, even if the
flag is inherited. Keep the development server bound to loopback.

Only the September 2026 sample has a report. Other months show an empty state, and
future selections are rejected. Changing the month updates the URL and all report
context together; navigation retains the period. Dates use Asia/Kolkata.

Synthetic financial fixtures live in `lib/preview/fixtures.ts` and static chart
geometry lives in `components/preview/sample-charts.tsx`. These are development
examples, not report APIs, valuation rules, or evidence about any household. The
fixtures never query a database or accept uploads. The state selector demonstrates
loading, empty, error/retry, incomplete, stale, quota-paused, and long/negative/unknown
values. The loading example deliberately remains until another state is selected.

`/login` supports authentication and `/setup` bootstraps the first owner; subsequent
household access requires an invitation. `/dashboard` requires active household
membership, and `/status` requires owner authorization. Owners and editors can review bank and card imports; viewers can read batch status. The live Overview, Accounts, Liabilities and Activity screens read one authenticated schema 13 installation and follow the global month selector. Synthetic preview reports never stand in for real reports. See [live bank reports](live-bank-reports.md) and [credit cards](credit-cards.md).

## Shared components

| Location | Responsibility |
| --- | --- |
| `components/shell` | AppShell, Sidebar, Topbar and MonthPicker; supplied profile identity/actions; navigation and reporting period |
| `components/ui/primitives.tsx` | Brand, MoneyValue, DataQualityIndicator, ChartFrame, empty/error/loading states, Disclosure and AccessLayout |
| `components/ui/dialog.tsx` | Native dialog with focus containment, Escape/backdrop dismissal and focus return |
| `components/ui/data-table.tsx` | Bounded presentation table, accessible sort state and independently expandable details |
| `components/dashboard` | Preview panels plus the live pinned bank overview and report states |
| `components/imports/bank-import.tsx` | Bank CSV preview, categories, review warnings, explicit confirmation and manual batch status |
| `components/imports/card-import.tsx` | Card CSV preview, facility/statement evidence, row decisions and explicit confirmation |
| `lib/presentation` | Exact decimal-string formatting, month handling, centralized name/navigation |

The small preview report table uses semantic HTML; it has no paging or virtualisation.
Import review uses paginated semantic HTML and native form controls. Introduce the
selected TanStack Table/shadcn/Recharts packages only when interactions need them,
checking compatibility then. PapaParse handles local CSV parsing; no alternative
component/chart library is introduced. Static sample chart
geometry is intentionally confined to the preview, so it cannot become an accidental
financial calculation implementation.

Money stays a decimal string. The display formatter groups Indian digits without a
Number conversion, truncates to the explicitly requested display precision, and
retains the full value in its title. It never changes stored values or computes
financial totals. Unknown amounts display a dash with a reason, never zero. Display
sorting compares decimal values exactly; unknowns remain last in either direction.
Future reporting contracts must supply rounded values and disclosure precision.

## Reviewed bank and card imports

Phase 5 extends the same Poppins, light lavender, white-panel and violet-action
workspace. Statement fields use two columns, stacking below 701px. Review displays
50 transactions per page; rows become labelled blocks below 1001px of panel width,
with a single content column below 601px. Existing events and observations load in
100-record pages, and history shows the latest 100 batches.

Labelled inputs, fieldset legends, native selects and checkboxes retain keyboard
access and shared visible focus. Loading and result messages use status announcements;
errors use alerts. Eligible income/expense categories can be assigned individually
or to selected rows in bulk. Transfers, card principal and equity adjustments do not
receive spending categories.

Choosing a CSV creates a browser preview. Requesting a review sends its bounded
payload but saves nothing. Each warning requires acknowledgement before explicit
whole-batch confirmation; editing the import clears its review and acknowledgements.
Cancel discards the preview. Readiness and history refresh through user actions,
without polling.

An amber panel with a textual “Confirmation paused” status explains unavailable admission and offers a readiness recheck. Confirmation becomes available only during a manually reviewed workflow-capacity lease; configuration alone does not enable it. A queued batch is not a published report. See [bank-imports.md](bank-imports.md)
for the server limits, admission contract and evidence semantics.

The statement-type switch opens a dedicated card workflow. Card fields capture the
statement outstanding, payment date, minimum due, facility and credit limit. Repayments
require an INR bank/cash account and never receive a spending category. The liabilities
screen uses the same report release as the overview and shows explicit unknown, zero-limit
and over-limit states without treating unused credit as an asset.

## Visual contract

- Poppins 400/500/600/700 is self-hosted through `next/font/local`. Font version and
  redistribution details are in `public/fonts/README.md`; the OFL license is bundled.
- Semantic CSS variables in `app/globals.css` map to Tailwind theme names for page,
  surface, text, border, action and data roles. White panels sit on lavender `#F1F2FF`;
  cobalt `#466CE8` denotes data and violet `#5847C6` actions. Coral/pink/amber support
  categories. Smaller error text uses a darker pink for contrast.
- Panels use 14px corners, fine borders and 20px spacing. Persistent navigation is
  254px wide, or 82px collapsed; it becomes a native modal drawer below 901px.
- Preserve the current reading order: summary cards → monthly flow with a
  largest-expense sentence → investment portfolio. Balance/liability panels occupy
  the right rail on wide screens and follow the primary column on smaller screens.
- Period selection, profile and notifications share the flat topbar. No search or
  theme switch. The mobile period control occupies a full row.
- Charts have descriptions and explicit readable values. Wide cash-flow geometry
  scrolls inside its frame on narrow screens. Portfolio rows adapt to labelled
  blocks below 640px of panel width; sorting remains visible and operable.
- Focus outlines, skip navigation, disclosure buttons, native modal focus trapping,
  touch targets and reduced-motion overrides are shared. Sidebar density persists
  locally; no financial or identity information is stored in browser preferences.

The local `DESIGN.md` records the extraction. Older green-dashboard briefs and dark
mode references are stale and were not rewritten. The current dashboard removed
composition donuts on 2026-09-15; the style guide retains a donut concept, which is
not a dashboard requirement. Font/body sizes and muted text contrast are adjusted
where needed for readability rather than copying inaccessible reference values.

## Verification

`npm run check` covers lint, types, unit tests and the production build.
`npm run test:e2e` covers the responsive shell alongside existing runtime isolation.
The test runner explicitly enables the local preview on one isolated server and
verifies that a Vercel preview server refuses it. No database is required for these
UI checks. Use `PLAYWRIGHT_BROWSERS_PATH=.cache/playwright` if browsers were installed
in this repository's ignored local cache.

`npm run test:e2e:auth` covers authenticated access and the reviewed import flow
against guarded local test Postgres, using synthetic capacity verification for
confirmation. See [bank-imports.md](bank-imports.md) for integration coverage; these
checks do not establish production readiness or test unpublished reports.

Visual evidence is written into `test-results` for wide desktop, collapsed rail,
tablet, mobile drawer/month picker and 320px edge values. The evidence uses only
synthetic examples. Inspect desktop and mobile together; group fixes before a final
confirmation pass.

For a second browser engine, install `npx playwright install firefox` and run
`PLAYWRIGHT_BROWSER=firefox npm run test:e2e`. This uses desktop and mobile viewport
sizes; the Firefox mobile project is responsive viewport testing, not iOS emulation.
On this workstation add `PLAYWRIGHT_BROWSERS_PATH=.cache/playwright` to both commands.
The initial Chromium run stalled even on `about:blank` while waiting for animation
frames; Firefox supplies the completed Phase 2 interaction and visual evidence.

The reviewed Phase 2 captures and accessibility scan are retained locally in
`.cache/phase2-evidence` so a later targeted test run does not erase them.
