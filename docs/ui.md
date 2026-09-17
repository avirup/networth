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

`/login`, `/setup`, and `/status` expose only honest unavailable screens. No credential
form, account creation, authenticated household route, financial endpoint, or import
operation is enabled in this phase. `/dashboard` and financial APIs remain closed.
Detailed installation status requires the later owner authorization implementation.

## Shared components

| Location | Responsibility |
| --- | --- |
| `components/shell` | AppShell, Sidebar, Topbar and MonthPicker; supplied profile identity/actions; navigation and reporting period |
| `components/ui/primitives.tsx` | Brand, MoneyValue, DataQualityIndicator, ChartFrame, empty/error/loading states, Disclosure and AccessLayout |
| `components/ui/dialog.tsx` | Native dialog with focus containment, Escape/backdrop dismissal and focus return |
| `components/ui/data-table.tsx` | Bounded presentation table, accessible sort state and independently expandable details |
| `components/dashboard` | StatCard, Portfolio, cash balance and credit utilisation presentation |
| `lib/presentation` | Exact decimal-string formatting, month handling, centralized name/navigation |

The small report table uses semantic HTML; it has no paging or virtualisation.
Introduce the selected TanStack Table/shadcn/Recharts packages when real import or
report interactions need them, checking compatibility then. This phase adds no
JavaScript dependencies or alternative component/chart library. Static sample chart
geometry is intentionally confined to the preview, so it cannot become an accidental
financial calculation implementation.

Money stays a decimal string. The display formatter groups Indian digits without a
Number conversion, truncates to the explicitly requested display precision, and
retains the full value in its title. It never changes stored values or computes
financial totals. Unknown amounts display a dash with a reason, never zero. Display
sorting compares decimal values exactly; unknowns remain last in either direction.
Future reporting contracts must supply rounded values and disclosure precision.

## Visual contract

- Poppins 400/500/600/700 is self-hosted through `next/font/local`. Font version and
  redistribution details are in `public/fonts/README.md`; the OFL license is bundled.
- Semantic CSS variables in `app/globals.css` map to Tailwind theme names for page,
  surface, text, border, action and data roles. White panels sit on lavender `#F1F2FF`;
  cobalt `#466CE8` denotes data and violet `#5847C6` actions. Coral/pink/amber support
  categories. Smaller error text uses a darker pink for contrast.
- Panels use 14px corners, fine borders and 20px spacing. Persistent navigation is
  254px wide, or 82px collapsed; it becomes a native modal drawer below 901px.
- Preserve the current reading order: three summary cards → monthly flow with a
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
