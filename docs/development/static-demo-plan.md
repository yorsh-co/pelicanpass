# Static Demo — Implementation Plan

**Status:** implemented. The runbook is [`demo-site.md`](../operations/demo-site.md); this plan is kept as the design record.

A public, interactive demo of PelicanPass as plain files on Cloudflare Pages at
`pelicanpass.demos.yorsh.co`, for the README and a portfolio. There is no server, database,
cache or Worker. Pages are rendered at build time from the real views. In the browser, a mock
replaces the API, so check-in, the pass, staff redemption and the raffle work against
in-memory state.

## Decisions

These were settled before the plan was written. Change them here first if they change.

| Decision      | Choice                                                                                       | Why                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Host          | `pelicanpass.demos.yorsh.co`, its own Pages project                                          | Served at `/`, so the ~1,000 root-absolute URLs work unchanged; independent deploys and origin per demo     |
| Attendee side | Interactive: landing → check-in → pass, staff scan and redeem, raffle draw                   | That is the product; snapshots alone do not show participant-initiated check-in                             |
| Admin side    | Read-only views, mutations refused with a "disabled in the demo" notice                      | Shows the breadth of the tool without building a second backend                                             |
| State         | Per-tab, in `sessionStorage`, with a reset control                                           | Each visitor gets a clean event; nothing is shared or persisted                                             |
| Clock         | Every page renders in the "event open" state; no countdown                                   | A countdown baked into static files at build time goes stale                                                |
| Production    | No behaviour change. One extraction refactor (phase 1); the mock never ships in `npm run build` | The demo must not be able to break, or leak into, the app it demonstrates                                 |

## Starting point

- **`scripts/static/build.ts`** (`npm run build:static`) already turns a server render into
  Pages files. It strips each nonce and moves its hash into a generated `_headers` CSP, follows
  HTML, CSS and JS references to copy only the assets used, and tests all of it in
  `build.test.ts`. `stripNonces`, `cspHash` and `referencesOf` are exported. `hashPolicy`, the
  headers writer and the asset copier are not.
- **`src/web/views/render-snapshots.test.ts`** renders every top-level view through the real
  Express view engine with `express-ejs-layouts`. Its ~50 fictional `ViewCase` fixtures pin
  the nonce, release, locale and clock (`landing`, `checkin`, `pass-participant`,
  `pass-volunteer`, `staff-scan`, `raffle-draw`, `admin-home`, `admin-metrics-full`, …). The
  fixtures live inside the test file.
- **All API traffic goes through one call.** `request()` in
  `src/web/client/core/api/api.request.ts` calls the global `fetch`. The one exception is
  `report-error.ts`, which also uses `navigator.sendBeacon` for `/api/v1/client-errors`. The
  response types are in `api.types.ts` and in each `api.*.ts` module.
- **The CSP is inline in `src/app.ts`** (helmet config). The fallback has its own copy in
  `src/fallback/app.ts`.
- **Client entry points** are matched by `ENTRY_PATTERNS` in `scripts/build-client.ts`
  (`pages/**/index`, `theme/*`, `telemetry/*`). A module outside those patterns is only
  bundled when something imports it.
- **Server-only behaviour the static site loses:** session cookies, `/checkin?t=…` entry-token
  handling (`checkin-entry.ts`), admin `POST` forms, and the server-side choice of which
  check-in step to render.

## Success criteria

1. `npm run build:demo` writes `dist/demo/`. `wrangler pages deploy dist/demo` serves it with
   no Functions.
2. On a phone, a visitor can enter a demo ticket code, check in, see their pass with a check-in
   number and QR, and change their nickname. A second tab on `/staff` can redeem that pass's
   items, and the pass shows the redemption at its next poll.
3. `/raffle` draws from the attendees who are checked in.
4. Admin pages render with fixture data. Every admin mutation shows the demo notice and changes
   nothing.
5. No response carries a nonce. Every inline script and style is hashed in the CSP. Every local
   reference resolves to a shipped file.
6. Every `/api/v1/*` path in the shipped bundles has a mock handler or an explicit refusal, or
   the build fails.
7. `npm run build` output, the view snapshots and the existing test suite are unchanged.
8. Every page carries the demo banner. The site sends `X-Robots-Tag: noindex`.

## Phase 1 — Shared fixtures and CSP

**Refactor only; no behaviour change.**

- Move the `ViewCase` fixtures and their `Context` helpers (`adminMessages` and the rest) from
  `render-snapshots.test.ts` into `src/web/views/fixtures.ts`. The test imports them from there.
- Move the helmet CSP directives out of `src/app.ts` into an exported constant, for example
  `src/config/csp.ts`. `app.ts` keeps applying them through helmet with the nonce.
- Export `hashPolicy`, `headersFile` and the reference-following asset copier from
  `scripts/static/build.ts`. If moving them reads more cleanly, put them in
  `scripts/static/site-files.ts` and have `build.ts` import them.

**Verify:** the view snapshots match byte for byte without `UPDATE_VIEW_SNAPSHOTS`.
`app.csp.test.ts` and `scripts/static/build.test.ts` pass unchanged. `npm run build:static`
output does not change.

**Commit:** `refactor(views): share render fixtures and CSP directives`

## Phase 2 — Demo build

`scripts/demo/build.ts` with `--out` (default `dist/demo`, git-ignored), and
`"build:demo": "npm run build && node scripts/demo/build.ts"`.

1. **Render.** Mount the real view engine the way `render-snapshots.test.ts` does. Render the
   fixtures below with a real per-render nonce, then strip it with `stripNonces`.

   | Output                                               | Fixture                                                              |
   | ---------------------------------------------------- | -------------------------------------------------------------------- |
   | `index.html`                                         | `landing`, open state                                                |
   | `checkin.html`                                       | `checkin`                                                            |
   | `pass.html`                                          | `pass-participant`                                                   |
   | `staff.html`                                         | `staff-scan`                                                         |
   | `raffle.html`                                        | `raffle-draw`                                                        |
   | `privacy.html`, `terms.html`                         | `privacy`, `terms`                                                   |
   | `admin.html`, `admin/<page>.html`                    | `admin-home`, `admin-metrics-full`, `admin-attendees-list`, `admin-lookup-search`, `admin-lookup-detail`, `admin-redemptions-index`, `admin-redemptions-detail`, `admin-tshirts-search`, `admin-volunteers-index`, `admin-survey`, `admin-whatsapp-idle`, `admin-pass` |
   | `404.html`                                           | `error-with-action`, action back to `/`                              |

   Any fixture that cannot render the open state as it stands gets a demo variant in
   `fixtures.ts`. Do not add special cases to the views.

2. **Banner.** A partial or build-time insertion straight after `<body>`, styled by
   `css/demo.css` and shown without JS. It says the event and data are fictional, lists two or
   three demo ticket codes, and links to the repository. A reset button joins it in phase 3.

3. **Assets.** Use the shared copier, seeded from the rendered pages. It copies only what they
   reference.

4. **`_headers`.** The production directives from phase 1 with nonces swapped for hashes, plus
   the existing helmet-equivalent headers and `X-Robots-Tag: noindex`. No `no-store`.

5. **`_redirects`.**
   - Rewrite (`200`) each detail route the views link to onto its single fixture, for example
     `/admin/lookup/* /admin/lookup-detail 200`.
   - Send `/admin/login` (`302`) to `/admin`.
   - Also write `robots.txt` with `Disallow: /`.

**Tests** (`scripts/demo/build.test.ts`, modelled on `scripts/static/build.test.ts`):

- Every expected file is written.
- No nonce remains anywhere.
- Every inline hash is in the policy.
- Every local `href`, `src` and `action` resolves to a file or a `_redirects` rule.
- Every page carries the banner.
- `js/demo/` does not exist in `src/web/public/js` after `npm run build`.

**Rehearse:** `npx wrangler pages deploy dist/demo --project-name pelicanpass-demo`, then check
on `*.pages.dev`:

- The pages render and admin pages can be navigated.
- `/admin` and `/admin/metrics` both resolve. Pages' clean-URL rules for a file and a folder
  of the same name are the one routing risk.
- The theme toggle works.
- Unknown paths show `404.html`.

At this stage the API calls fail, so the pages show their own error and offline states.

**Commit:** `feat(demo): render static demo site for Cloudflare Pages`

## Phase 3 — Mock API

Source in `src/web/client/demo/`. It falls outside `ENTRY_PATTERNS`, so production never
bundles it, but it is still type-checked and linted with the client. `scripts/demo/build.ts`
bundles it to `js/demo/mock-api.js` and injects it as the first `<script>` of every page.

- **`state.ts`** holds pure state and transitions:
  - A roster of about 20 fictional attendees (participants and volunteers) with six-character
    ticket codes.
  - Check-in numbers, nicknames, redemptions, survey answers and raffle draws.
  - One function per endpoint: `(state, request) → { state, status, body }`.

  It touches no DOM or storage, so `node:test` can cover it directly.
- **`mock-api.ts`** replaces `window.fetch` for same-origin `/api/v1/*` and passes everything
  else through.
  - It also replaces `navigator.sendBeacon` for `/api/v1/client-errors` and drops those
    reports.
  - It adds 150–400 ms of latency, so the skeletons and pending states show.
  - It honours `AbortSignal`, because `request()` times out with one.
  - It loads and saves state in `sessionStorage`, inside `try`/`catch`, and falls back to
    in-memory state.
  - It wires up the banner's reset button.
- **Response shapes** are typed from `api.types.ts` and the `api.*.ts` envelopes, so a contract
  change breaks the type-check instead of the demo.
- **Errors** use the backend's envelope (`{ error, code, details }`) with existing
  `ApiErrorCode`s, so the real error UI renders them. A wrong ticket code gets the same code
  production sends.
- **Endpoints:**
  - `checkin/*` and `attendee/*`: the check-in flow, the pass, nickname and logout.
  - `pass/band` and `staff/band`: polling. `staff/verify`, `staff/lookup` and `staff/redeem`
    accept the demo pass's QR payload or a ticket code.
  - `raffle/*`: draws and reset.
  - `survey`: accepted and discarded.
  - `admin/metrics`: fixture figures.
  - Every other `admin/*` path: refused (phase 4).
- **Entry token.** `/checkin?t=…` and `?audience=` keep working client-side. The server
  handling in `checkin-entry.ts` is skipped. The mock treats the "session" as present once a
  ticket has been checked in.
- **Turnstile.** Render the demo fixtures with no site key. If the check-in client still
  requires one, the mock stubs `window.turnstile`. Check this before choosing.

**Tests:**

- Transitions in `state.ts`: check-in, a repeat check-in, a redemption, an undo, a raffle draw
  with an empty pool.
- A build-time coverage test. It scans the shipped bundles for `/api/v1/` literals, including
  template-literal paths, and fails if any path has neither a handler nor an explicit refusal.

**Commit:** `feat(demo): mock the attendee, staff and raffle API in the browser`

## Phase 4 — Read-only admin

- In the mock script, catch `submit` on any `form[action^="/admin"]` with a non-`GET` method.
  Cancel it and show the existing toast component with the demo notice.
- Admin `fetch` mutations get the same notice through the mock's refusal.
- Logout links go back to `/admin`.
- Make the metrics dashboard poll the mock's fixture figures. Deterministic jitter on reload is
  optional, so it does not look frozen.

**Verify:** every admin form and button produces the notice and changes nothing on reload.

**Commit:** `feat(demo): make admin views read-only in the demo`

## Phase 5 — Deploy and document

- Add `demo-site.md` to `docs/operations/`, written as a runbook in the style of `static-site.md`:
  - The build.
  - Direct Upload to the `pelicanpass-demo` Pages project.
  - The custom domain `pelicanpass.demos.yorsh.co`.
  - Checking that Pages issued the certificate for the nested hostname. If it did not, fall
    back to `pelicanpass-demo.yorsh.co`.
  - The phone checklist from the success criteria.
  - How to redeploy.
- Add rows to `docs/README.md` for the runbook. Remove or update the row for this plan.
- Add a "Live demo" link and badge to the README header and _About the project_.
- Add a `CHANGELOG.md` entry.

**Commit:** `docs(demo): add demo runbook and README link`

## Out of scope

- A Git-integrated Pages build. Direct Upload matches `static-site.md` and keeps build secrets
  out of Cloudflare.
- Locales other than pt-BR, which is what production ships.
- Admin mutations, CSV import and export, and WhatsApp sending.
- Shared state between visitors, and analytics beyond Cloudflare Web Analytics, if enabled on
  the project.
- The `demos.yorsh.co` index page. It is a separate project.

## Risks

- **Fixture drift.** A view change that needs new locals breaks the snapshot test first,
  because phase 1 makes both use the same fixtures.
- **API contract drift.** Typed responses and the coverage test catch it at build time. A
  behavioural change that keeps the same shape, such as a new step order in check-in, is only
  caught by the phone rehearsal.
- **Time-gated UI.** The pass survey and the welcome schedule depend on the time of day. The
  mock answers as if the event is open and the survey is available. Check both against the
  pass client's own clock checks.
- **Camera scanning.** `/staff` needs a second device or screen showing the demo pass QR. The
  ticket-code lookup is the path a single-device visitor can use, so the banner should say so.
