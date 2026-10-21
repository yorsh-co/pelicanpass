<div align="center">

# PelicanPass

**In-person conference experience web app with participant-initiated check-in, attendee passes and volunteer tooling.**

[![Node][node-badge]][node-url]
[![TypeScript][ts-badge]][ts-url]
[![Express][express-badge]][express-url]
[![PostgreSQL][pg-badge]][pg-url]
[![Redis][redis-badge]][redis-url]
[![Docker][docker-badge]][docker-url]
[![License: MIT][license-badge]](#license)

[Live demo](https://pelicanpass.demos.yorsh.co) · [About](#about-the-project) · [Engineering
highlights](#engineering-highlights) · [Getting
started](#getting-started) · [Documentation](#documentation)

</div>

<details>
<summary>Table of contents</summary>

- [About the project](#about-the-project)
  - [Built with](#built-with)
- [What it does](#what-it-does)
- [Engineering highlights](#engineering-highlights)
- [Capacity](#capacity)
- [Architecture](#architecture)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation — Docker Compose](#installation--docker-compose)
  - [Development stack](#development-stack)
  - [Environment](#environment)
- [Usage](#usage)
- [Development](#development)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [License](#license)
- [Disclaimer](#disclaimer)
- [Contact](#contact)
- [Acknowledgments](#acknowledgments)

</details>

---

## About the project

PelicanPass was originally created for a one-day youth conference with roughly 500 participants and 200 volunteers. Load-tested before the event, the host it ran on carried seven times that participant count comfortably on its busiest phase ([Capacity](#capacity)). It is a portfolio project, provided as is: see the [Disclaimer](#disclaimer). A [live demo](https://pelicanpass.demos.yorsh.co) with fictional data runs entirely in the browser; [`docs/operations/demo-site.md`](docs/operations/demo-site.md) describes how it is built and deployed.

At the live event on 17/10/2026, 528 of 558 participants and 119 of 119 volunteers checked in and no request was refused for load. The busiest minute saw 17 check-ins and the busiest 15 minutes 92. The [event report](docs/reports/event-2026-10-17.md) has the figures, the incidents and what the data cannot show.

The web app's goal was to solve two recurring pain points for the event organizers, as well as maintain the features that their existing solutions already covered:

- Participant-inititated check-in (avoids long check-in queues and reduces the number of required volunteers at the door), with separate participant and volunteer audiences.
- T-shirt, drink and meal redemptions (bought ahead of time), plus lunch and a volunteer t-shirt for volunteers, all available in the same interface.
- Live raffle draws that draw from a pool of numbers that each refers to a specific participant that completed the check-in.
- Built-in, anonymous experience questionnaire for participants and volunteers.
- Ticket codes delivered to each attendee over WhatsApp before the event.
- Time specific features.
- In app venue map.
- A live admin interface allowing for adding new participants at the door.
- Every screen reads its copy from message catalogs; pt-BR is the only locale shipped.
- Does not include the ticket and item purchase process, that was covered separately.

Specific constraints drove a number of decisions:

- Shared wi-fi and venue NAT as well as carrier NAT required rate limits sized for hundreds of people sharing one IP.
- Telemetry is self-hosted because attendee data may not leave the host.
- The host machine had limited memory available, so status and tracking was built from scratch rather than using an existing tool.
- Application degrades rather than fails, in specific, chosen ways.

### Built with

| Choice                                  | Why                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node 24**, native type stripping      | `.ts` runs directly — there is no backend build step, and no compiled artifact that can drift from the source. Requires Node 24 minimum.        |
| **Express 5** + EJS                     | Server-rendered first paint on every page, including the live metrics dashboard.                                                                |
| **Vanilla TypeScript**, esbuild-bundled | Progressive enhancement over a rendered page. Every surface has a defined no-JS behaviour; the admin rail degrades to a stacked list.           |
| **PostgreSQL 16**, raw `pg`             | All SQL lives in repository modules. Column-level grants are intentional (see [highlight 3](#3-append-only-auditing-enforced-by-the-database)). |
| **Redis 8**                             | Sessions, rate-limiter buckets, single-use pass tokens, metrics counters.                                                                       |
| **ICU MessageFormat**, `@formatjs`      | Every string on every screen comes from a catalog, checked for completeness and hardcoded copy in `npm run check`.                              |
| **Docker + Caddy + Cloudflare Tunnel**  | Nothing publishes a host port. All ingress is an outbound tunnel connection.                                                                    |
| **Tailscale + Cloudflare Access**       | The admin surface answers only to tailnet devices, or on the public host to an Access-verified identity, checked again at the origin by `jose`. |

---

## What it does

One Express app, three session types — check-in, attendee and admin — each with
its own cookie and lifetime.

### Check-in

A resumable state machine — `ticket → verification → qr → success` — persisted
server-side, so progress survives a reload. A completed check-in follows the
attendee to a new device, and checking in on a second device ends the session on
the first. Three entry paths converge on one session: a typed code, a personal
link whose token is consumed into the session and then `303`'d out of the URL so
it never lands in browser history, and the venue poster QR.

Participants and volunteers each have their own ticket code format, copy and
pass. Every ticket code is six characters: a one-character key and five
alphanumerics. Volunteer codes use the key
`v`, and tickets from another source carry their own key, so they check in
alongside the sign-up system's. Identity is confirmed
by the last four digits of the registered phone, against a masked-name preview;
repeated failures escalate to a Turnstile challenge, and a global failure budget
switches it on for everyone. The in-browser scanner handles torch control and
permission failure, and is imported dynamically so the library lands in its own
chunk. Completion assigns participants a sequential arrival number atomically
from a Postgres sequence; volunteers do not draw one.

With `LANDING_ENABLED`, a countdown holds the app until each audience's check-in
window opens, and check-ins made before it are refused.

`src/modules/checkin/checkin.flow.ts` · `src/middleware/landing.middleware.ts`

### Attendee pass

A flip card carrying the arrival number, entitlement chips (a collected one
leaves the pass an hour after redemption), a display name the
attendee can set, a venue map and a rotating verification band
(`PASS_BAND_ENABLED=false` drops the band for a plain clock). Pass tokens are
single-use (Redis `SET NX` on a hash of the signature), version-tagged,
event-scoped and constant-time compared. The refresh loop syncs to the server's
remaining-window time rather than the device clock.

The welcome line under the name changes text over the event:
`PASS_WELCOME_SCHEDULE` sets when each phase of the `pass.welcome` message
starts, and open passes switch within 30 seconds. Volunteers with a team see
their team there instead. `/admin/pass` (`pass:write`) edits the schedule
without a shell: a saved schedule replaces the `.env` one until it is handed
back. It can also schedule a _Personalizado_ line, written on the row itself
(up to 100 characters), which every pass shows as written and untranslated,
whatever the attendee's questionnaire. `.env` cannot set one. A build older
than this feature reads a saved schedule holding one as invalid and follows
`.env` until it is saved again.

A volunteer's pass shows what they can do: a tab beside the logo in the tier's
colour, with a chip — `CADASTRO`, `CONSULTA`, `CAMISETAS`, `RETIRADAS` or
`GERADOR DE N°`, highest first. The highest tier that applies wins. Tapping the
tab opens the volunteer's actions — the staff, raffle and admin links, which no
longer sit on the pass front. A volunteer can be linked to an administrator
account through `attendees.admin_username`; that link is a label and grants
nothing, since every admin gate still authenticates against `admins` on its own.

`src/modules/pass/pass.service.ts` · `src/constants/pass.ts` ·
`src/config/pass-welcome.ts` · `src/modules/pass/pass.welcome.ts` ·
`src/modules/attendee/attendee.access-tier.ts` · [`docs/features/admin-scopes.md`](docs/features/admin-scopes.md#pass-access-tiers)

### Volunteer surfaces

The redemption counter (`/staff`): scan a pass, review what the attendee is
entitled to and what they have already collected, then slide to confirm the
handover. All three outcomes — `redeemed`, `duplicate`, `not_entitled` — are
written to an append-only audit table. Volunteers can be scoped to one station
or any subset of them, and there is a typed-code fallback for a dead camera.

The live raffle (`/raffle`) draws from the pool of checked-in numbers using
`randomInt` rather than `Math.random()`, with repeat-allowed and put-back
controls. It is gated by its own `can_draw` flag — deliberately not the same
predicate as redemption.

Both run on the volunteer's own attendee session, with permissions re-read from
Postgres on every request, so revoking one takes effect on the next tap.

`src/modules/staff/` · `src/modules/raffle/`

### Admin

Reachable two ways: over the tailnet through a Tailscale sidecar, or on the
public hostname behind Cloudflare Access, whose signed assertion the origin
verifies again rather than trusting the edge
(`src/middleware/access-jwt.middleware.ts`). Password login with a Turnstile
challenge, then scope-gated screens:

- a roster editor, searching accent-folded names and nicknames, exact ticket
  codes and phone digits, whose item dropdowns offer only the options approved
  for the attendee's role (the meal differs between participants and
  volunteers), enforced again on save and in the roster import;
- a door lookup with manual mark-present, and an attendee editor that shows
  check-in status and can mark present too (`checkin:write`);
- a volunteer permissions screen (`/admin/volunteers`, `volunteers:write`):
  stations, raffle, admin link, team and check-in time, with a collapsible
  legend of every access tier;
- the WhatsApp sender and the questionnaire controls described below;
- a redemptions screen: per-item totals (expected, collected, still to collect
  on site and not yet arrived) with a per-option breakdown for the stock
  table, who is entitled to each item, and per attendee the counter's full
  history and an audited _undo_ or _mark collected_, each with a reason code;
- a T-shirt desk for a separate team: search for an attendee who bought a
  shirt and record the hand-over with a two-press button, under one scope
  that needs no other;
- a ticket limit on the roster: a cap on participant tickets, counting every
  one (`total`) or only codes generated at the door (`door`), that either
  refuses a new or restored participant at the cap (`hard`) or lets it through
  with a warning (`warn`). Everyone who can open the roster sees its status;
  setting it needs `attendees:limit`;
- a live metrics dashboard — door throughput with participant check-ins by
  ticket prefix and the ticket limit status, redemptions, dependency health,
  errors, latency and every rate limiter. `limiterRegistry` seeds the limiter
  table, so every limiter has a row and a true ceiling from the first paint,
  rather than appearing only once something has been refused, when "no traffic
  yet" and "the instrumentation is broken" look identical.

Nav entries are paired with the same scope their route enforces, so a section
cannot be shown that will then redirect.

`src/modules/admin/` · `src/constants/admin-nav.ts` · `src/constants/admin-scopes.ts` · [`docs/features/admin-scopes.md`](docs/features/admin-scopes.md) · [`docs/features/redemption-options.md`](docs/features/redemption-options.md) · [`docs/operations/deployment.md`](docs/operations/deployment.md#the-ticket-limit)

### Questionnaire

An experience questionnaire per audience, with questions authored in Markdown
and validated against a grammar by `npm run survey:check`. A chip on the pass
opens it only while it is open and unanswered. Each attendee can answer once,
and the answers are stored apart from the record of who answered, which
`purge-attendees.sql` deletes before the final report. The release window comes from `SURVEY_*`, and
`/admin/survey` can override it (`survey:write`) and download each audience's
answers as CSV (`export:read`).

`src/modules/survey/` · [`docs/features/survey.md`](docs/features/survey.md)

### WhatsApp ticket delivery

`/admin/whatsapp` (`whatsapp:send`) sends every attendee their ticket code
through the WhatsApp Cloud API as a resumable run: a preview with a cost
estimate, spend so far, and stop, cancel and retry controls. Delivery receipts
arrive on a signed webhook, mounted ahead of the JSON parser because Meta signs
the raw bytes.

Volunteers get their own door template (`WHATSAPP_DOOR_TEMPLATE_VOLUNTEER`,
required whenever door messages are enabled), which can carry their team,
check-in time and lunch slot. The check-in time (`HH:MM`) comes from the roster
import or `/admin/volunteers`.

`src/modules/whatsapp/` · [`docs/features/whatsapp-integration.md`](docs/features/whatsapp-integration.md)

### After the event

From `EVENT_CLOSES_AT`, the public pages show a thank-you page and the attendee
API answers `410 EVENT_CLOSED`, so a pass left open lands on it at its next
poll. `/admin` stays open for the teardown's exports.

`src/middleware/landing.middleware.ts` · [`docs/operations/fallback.md`](docs/operations/fallback.md#5-the-closing-page)

### Resilience on the day

Two fallbacks, for two sizes of outage. The standalone fallback
(`npm run fallback`, or `compose.fallback.yml`) serves the countdown, privacy
notice, terms and closing page with no database, no cache and no production
secret, so the public hostname answers while the stack restarts.

The warm standby is a full copy of the app on a second host. A systemd timer
pulls a validated snapshot of Postgres and Redis every minute over a
forced-command SSH key, so a failover keeps check-ins and signed-in phones.
Restore reserves 500 check-in numbers, so one issued after the last snapshot is
never issued twice; cut-back hands production back. On 18/10 the standby served real traffic for about 40 minutes while the production host was offline ([event report](docs/reports/event-2026-10-17.md#the-1810-standby-episode)).

`src/fallback/` · `compose.fallback.yml` · `scripts/standby/` · [`docs/operations/fallback.md`](docs/operations/fallback.md) · [`docs/operations/standby.md`](docs/operations/standby.md)

### Languages

Every screen, the admin included, reads its copy from ICU message catalogs, with
the locale resolved per request. pt-BR is the only locale offered, and draft
locales never render in production. Catalogs round-trip to a translation
management system as XLIFF (`npm run i18n:export`, `npm run i18n:import`).

`src/i18n/` · [`docs/development/copy-management.md`](docs/development/copy-management.md)

---

## Engineering highlights

### 1. A pass that detects its own screenshot, with zero coordination

Every 30 seconds, the attendee's pass and the volunteer's screen each show the
same colour-and-word band, derived from `HMAC(secret, event | window)`. The
volunteer's screen fetches the current band for the event, never anything about
the pass in front of it — the two agree because _neither was told what the other
shows_. A pass forwarded to a friend is visibly stale to a volunteer who looked
nothing up.

`src/modules/pass/pass.service.ts` · `src/constants/pass.ts`

### 2. Rate limiting keyed on what an attacker cannot rotate

Twenty-one limiters, four of them split into a strict tier and a relaxed tier for
venue addresses. The code explicitly disclaims its own per-IP tier as _cost
control, not a guessing control_ — hundreds of phones behind one venue NAT means
an IP identifies a building, not a person. The controls that actually stop
guessing are failure budgets keyed on `attendeeId`, admin username and
volunteer, which survive a discarded cookie, plus a global check-in failure
budget that switches the Turnstile challenge on for everyone.

Two details worth the click: every Redis-backed limiter carries an in-process
insurance tier, so limiting fails **closed** during an outage rather than open;
and the admin login budget is consumed _before_ scrypt runs and cleared on
success, so a flood costs a Redis round trip instead of 100 ms of CPU while a
legitimate admin never carries spent budget.

`src/middleware/rate.middleware.ts` · `src/config/rate-limits.ts` · [`docs/performance/rate-limiting.md`](docs/performance/rate-limiting.md)

### 3. Append-only auditing, enforced by the database

The application role holds `INSERT` on `redemptions` and no `SELECT`. That is not
a convention the code agrees to follow — it is a grant, and it shows up as a
constraint in the code: `redeemItem` cannot use `RETURNING`. The metrics
dashboard reads a purpose-built `redemption_metrics` aggregate view instead of
being handed read access to the rows, and the redemptions screen reads one
attendee's history at a time through `redemption_history`, a `SECURITY DEFINER`
function, for the same reason. An administrator's correction is a row of its
own — `marked` or `reverted`, with the admin and a reason code — never an edit.

`migrations/009_redemptions.ts` · `migrations/017_app-events.ts` · `migrations/027_redemption-corrections.ts` · `src/modules/attendee/attendee.repository.ts`

### 4. Least-privilege Postgres, for one specific reason

Three lifecycle roles (`app`, `migrator`, `readonly`), column-level grants
throughout, and `event_id` in every `WHERE`. The load-bearing argument is not
least privilege in the abstract: a superuser has `COPY … FROM PROGRAM`, so any
injection anywhere in the application would have been remote code execution on
the database host.

`scripts/db/init/01-roles.sh` · `migrations/005_app-role-grants.ts` · [`docs/operations/db-cheatsheet.md`](docs/operations/db-cheatsheet.md)

### 5. A self-hosted telemetry stack, because none of it may leave the host

Privacy rules out Sentry and Grafana Cloud, so observability is built in:

- **Dual-sink counters** — an in-memory ring buffer serves the alert loop, which
  must survive the Redis outage it is reporting; Redis minute-buckets serve the
  dashboard, which must survive a container recreate. Writes are buffered and
  flushed once a second in a single pipeline.
- **A durable event sink** into `app_events`, batched, with a hard queue cap that
  drops rather than requeues, and a self-running retention purge.
- **A 30-second rule loop** over cached dependency probes that alerts only after
  consecutive failures, and Discord delivery with fingerprint deduplication and
  suppression counts (`×N suppressed since the last message`).

Every alert rule carries required `means` and `check` fields — required, not
optional, because _"a field a caller may omit is one the next rule will be
written without."_ An alert read at 20:00 does not need the runbook open beside
it.

`src/shared/telemetry/`

### 6. No attendee value ever travels in a page URL on the admin surface

Filters, search terms and attendee IDs all ride in POST bodies, a bookmarked
record URL only redirects, and record pages keep the attendee's name out of
`<title>`. A URL in the address bar is written to browser history, which
outlives the session, the tailnet grant and the account — and on a volunteer's
phone signed into a browser account, history syncs off the device entirely. The
JSON API behind those pages addresses records by ID in the path, but is only
ever called by `fetch`, never navigated to.

`src/web/routes/web.routes.ts`

### 7. Trust boundaries expressed as network topology

Five Docker networks, three of them (`edge`, `web`, `data`) `internal`, a read-only non-root
production container (`cap_drop: ALL`, `no-new-privileges`), and a Caddy edge
with two listeners. The public vhost takes traffic only from `cloudflared`; the
admin listener only from the Tailscale sidecar, which vouches for its requests
with an `X-Admin-Gate` header the public vhost strips from every inbound request.
Nothing publishes a host port. Someone holding the tunnel token still has no
route to Postgres.

`compose.prod.yml` · `Caddyfile` · [`docs/operations/deployment.md`](docs/operations/deployment.md) · [`docs/infrastructure/cloudflare-rules.md`](docs/infrastructure/cloudflare-rules.md) · [`docs/infrastructure/container-containment.md`](docs/infrastructure/container-containment.md)

### 8. No backend build step — and the consequence owned

`.ts` runs directly on Node 24 via native type stripping, so import specifiers
must name the file on disk. The trap is that a stale `./foo.js` **type-checks
clean and dies at boot** — `tsc` resolves it happily, Node does not. ESLint's
`import-x` Node resolver is what catches it, which is why `npm run lint` is not
optional here and a green `typecheck` alone is not sufficient.

[`docs/development/typescript-conventions.md`](docs/development/typescript-conventions.md)

### 9. Capacity measured, not assumed — and the measurement checks itself

A ladder runner steps k6 load up until the server breaks, bisects to the knee
and repeats either side of it. Every rung records the host, the commit, the
configuration and the host's own noise: a rung with more than a core of other
load, or a second of thermal throttling, is marked invalid and rerun, so a busy
laptop cannot pass for a slow server. Each rung is a versioned row in
`loadtest/history/`, the results page is generated from those rows, and
`npm run check` fails while it is stale. Load shedding was then tuned past the
knee against the same rows.

`scripts/loadtest/ladder.ts` · `scripts/loadtest/session.sh` · `scripts/loadtest/history/` · [`docs/performance/load-test-results.md`](docs/performance/load-test-results.md)

### 10. Overload: refuse the excess, bound every wait, make the re-tap safe

An overloaded server does not fail, it gets slow, and a phone spinning for
Cloudflare's 100 seconds gets tapped again. So the server refuses what it cannot
take at once, with `503` and `Retry-After`: everything while the event loop lags,
and otherwise only the requests arriving while the database queue is over its
limit. Checking that queue per request instead of behind a flag served 13 to 16
points more of the room past the knee, with a better p99. The browser gives up
at a known deadline and says so in words that blame neither side. Because a
request that timed out may still have committed, the two actions a re-tap would
duplicate take an idempotency key and replay their first answer, and every
other screen re-reads what actually happened rather than reporting a failure.

`src/shared/telemetry/load.policy.ts` · `src/middleware/idempotency.ts` · `src/web/client/core/api/api.request.ts` · [`docs/performance/overload-behaviour.md`](docs/performance/overload-behaviour.md)

<details>
<summary><strong>Also worth a look</strong></summary>

- **The `light-dark()` fallback floor** — every colour token is one `light-dark()`
  call preceded by a bare light value, so a phone below the iOS 17.5 / Chrome 123
  floor renders a permanently-light but _complete_ app instead of an unstyled
  page. At a door, on a device nobody can swap, that is the difference between
  degraded and broken. `src/web/public/css/base/variables.css`
- **The reduced-motion trap, found three times** — the base reset caps animations
  to `0.01ms`, which _parks_ a keyframed slide on a frame rather than skipping it,
  silently breaking indicators for exactly the users least likely to report it.
  Fixed by moving the raffle roll and the countdown reel to WAAPI, and stepping
  the rest from a JavaScript clock rather than a keyframe.
- **An empty `redeem_scopes` array was a privilege escalation** — `[]` is truthy
  and `<@` admits `'{}'`, so a volunteer with `can_redeem` and no stations passed
  the gate and could read any attendee's entitlements while every redeem `403`'d.
  Collapsed to `null`.
- **Deliberate non-abstraction, stated as policy** — `poll-loop.ts` documents why
  it is a _sibling_ of `band-loop.ts` rather than a generalisation,
  `adminPage()` shipped at the third screen rather than the first, and
  `digit-reel.ts` explains why it does not reuse the raffle's roll: _"If a third
  consumer appears, promote then: there will be two implementations to generalise
  from rather than one to guess at."_

</details>

---

## Capacity

Measured for the 2026 event, on the host that served it and on the development
laptop. Capacity belongs to a host and a commit, not to the project: another
event's host, or your own machine, measures its own with the same runner
([`docs/performance/load-testing.md`](docs/performance/load-testing.md#first-session-on-a-new-host)),
and its rows join these in the generated report.

| Host               | Hardware                                 | Raffle, comfortable | Raffle, ceiling | Survey   |
| ------------------ | ---------------------------------------- | ------------------- | --------------- | -------- |
| Event host (2026)  | Xeon E3-1220 v5, 4 cores, 8 GB, SATA SSD | 3,500 users         | 4,000 users     | ≥ 10,000 |
| Development laptop | i7-1260P, app on the performance cores   | 5,000 users         | 5,500 users     | ≥ 10,000 |

**Users** is the room the scenario models, scaled up: 500 participants at
`SCALE=1`, the event's own size. The raffle binds: after each draw most of the
room reloads its pass within a minute, and the app is one Node process, so one
core sets the limit. **Comfortable** is the last step with flat latency (p95
under 20 ms) and the figure to plan with; the ceiling is the last step that
passed. Past it, load shedding keeps the event host correct up to 10,000 people
— no server errors and no failed flows — by refusing the excess with
`503` and `Retry-After`.

The event host was measured at the 1.1.0 release candidate (2026-10-14); the
development laptop on earlier code (2026-09-30).

**How it was tested.**

- **k6 against a production-identical stack**: the same image, Postgres tuning,
  connection pool and read-only container, with only alerts, WhatsApp, the
  captcha and the date gates swapped for test settings.
- **A ladder per phase**: load doubles until a rung fails, then bisects to the
  knee and runs either side of it twice. Each rung starts from an empty
  database and Redis.
- **Rungs that cannot be trusted are discarded**: more than a core of other load
  on the host, or a second of thermal throttling, and the rung is rerun.
- **Shedding tuned past the knee** with the same runner, at the knee, 16× and
  20× the room.
- **Every rung is a versioned record** in `loadtest/history/`, and
  [`docs/performance/load-test-results.md`](docs/performance/load-test-results.md) is generated from
  them.

**What it does not show.** This is server capacity, not venue capacity: each
simulated phone has its own address, so no rate limit binds. A room behind one
venue address relies on that address being trusted, which the limiter runs test
separately. The Cloudflare edge, the tunnel and the host's uplink are outside
the test. Method and caveats: [What the numbers mean for an event](docs/performance/load-testing.md#what-the-numbers-mean-for-an-event).

**At the live event.** The room peaked at 17 check-ins in a minute and 92 in 15, modest against the test. A check-in is not a request, though: each takes several, and the event-day request log was lost, so the request-level comparison with the test is not possible. See the [event report](docs/reports/event-2026-10-17.md#predicted-and-observed).

---

## Architecture

```text
Internet ──▶ Cloudflare edge ──▶ (outbound tunnel) ──▶ cloudflared ──▶ caddy :80   ──▶ app ──▶ db
Tailnet  ──▶ tailscale serve (vpn sidecar) ─────────────────────────▶ caddy :8080 ──┘    └──▶ cache
```

In production, seven services on five networks, split by trust boundary (the
dev stack has no `migrate` service). `edge`, `web` and `data` are
`internal: true` and only `egress` (`tunnel` and `vpn`) and `app-egress` (`app` alone) have a gateway, so `proxy` has no
route out, a compromised connector has no route to `app:3000`, and Postgres and Redis have no route off the host at all.

| Service                | Networks                    | Reachable from       |
| ---------------------- | --------------------------- | -------------------- |
| `tunnel` (cloudflared) | `edge`, `egress`            | —                    |
| `vpn` (tailscale)      | `edge`, `egress`            | tailnet devices      |
| `proxy` (caddy)        | `edge`, `web`               | tunnel, vpn          |
| `app`                  | `web`, `app-egress`, `data` | proxy                |
| `migrate`              | `data`                      | — (`tools` profile)  |
| `db`, `cache`          | `data` _(internal)_         | app and migrate only |

### The API middleware chain

Ordering is load-bearing rather than stylistic, and is documented as such at each
mount point in `src/api/index.ts`:

```text
no-store                        ← first, so a 429 and every refusal carry it too
  → per-IP limiter
  → content-type gate (415)
  → same-origin check           ← not for /whatsapp/webhook/, which is signed instead
  → /client-errors              ← above the global parser, with its own 4kb limit
  → /whatsapp/webhook/<secret>  ← above the global parser, which would consume the
                                  signed raw bytes; mounted only when enabled
  → express.json (10kb)
  → body-parser error normalisation
  → NUL-byte check (400)        ← body and query; the web router runs it on its query
                                  strings and form bodies too
  → event-closed gate           ← /checkin, /attendee, /survey, /staff, /raffle:
                                  410 once the event has closed
  → /checkin                    ← window gate, runs before sessions exist
  → resolveSessions
  → /admin/auth                 ← login limiter, then captcha, before any session gate
  → /admin/metrics, /admin/whatsapp/runs/current, /admin/redemptions/summary
                                ← above /admin, so their polls escape its budget
  → per-surface limiter + role / permission gates
  → error handler
```

`src/app.ts` wraps that with request logging, counters, Helmet and a per-request
CSP nonce, a permissions policy, cookie parsing, three static cache tiers, the
`/healthz` and `/readyz` probes, load shedding (after the probes and static files, so neither
is ever shed), and the Cloudflare Access check on `/admin` and
`/api/v1/admin`. The two routes a re-tap would duplicate, attendee creation and
raffle draws, add `idempotent()` after their own session and permission gates.

### Module anatomy

Every feature module under `src/modules/<domain>/` uses the same file vocabulary:

```text
<domain>.routes.ts           Express router; mounting order documented
<domain>.controller.ts       thin — parse, delegate, respond
<domain>.service.ts          business rules
<domain>.repository.ts       all SQL for that table, nothing else
<domain>.session.model.ts    session shape          ┐ where the surface
<domain>.session.adapter.ts  type-bound wrapper     ┘ owns a session
```

`src/modules/attendee/` is the worked example. One generic `sessionService` is
type-bound per domain by a short adapter, so `SessionType` cannot be passed
wrong. Modules that own no table or session — `pass/`, `whatsapp/` — carry only
the files they need.

### Repository layout

```text
src/
├─ server.ts        boot: dependency retry, telemetry start, graceful shutdown
├─ app.ts           Express wiring: CSP, cache tiers, probes, mounts
├─ api/index.ts     /api/v1 router — the chain above
├─ config/env.ts    the whole env surface, validated at boot
├─ constants/       single sources of truth shared by server, client and migrations
├─ i18n/           message catalogs, locale resolution
├─ middleware/      20 cross-cutting concerns, explicitly ordered
├─ modules/         admin · attendee · captcha · checkin · client-error · metrics
│                   pass · qr · raffle · session · staff · survey · whatsapp
├─ shared/          db · errors · logger · telemetry · utils
├─ types/           domain types and Express augmentation
└─ web/
   ├─ routes/       page routes and the admin page factory
   ├─ views/        42 EJS templates — 3 layouts, pages, partials, components
   ├─ client/       browser TypeScript (outside the webroot, bundled by esbuild)
   ├─ content/      privacy notice, terms, questionnaires and redemption options,
   │                read from Markdown at boot
   └─ public/       webroot: css, assets, and the built js/ bundle

migrations/         001–037, node-pg-migrate, TypeScript
scripts/            client build · admin CLI · SQL helpers · seed · egress filter
                    i18n · survey · redemption · telemetry · whatsapp · qr · standby
                    load-test tooling
loadtest/           k6 event-day load test (TypeScript); see docs/performance/load-testing.md
docs/               documentation by area — index in docs/README.md
```

---

## Getting started

### Prerequisites

- **Node ≥ 24** — load-bearing, not a preference. There is no backend build step;
  the server runs `.ts` through Node's native type stripping. There is no
  `.nvmrc`.
- **npm** (the lockfile is `package-lock.json`)
- **Docker** and **Docker Compose**
- **`openssl`**, to generate secrets
- Two **Cloudflare Turnstile** key pairs, one for check-in and one for admin
  login — the captcha is verified server-side, so the app container needs egress
  to `challenges.cloudflare.com`

Production additionally needs a Cloudflare Tunnel token, a Tailscale auth key,
and a Cloudflare Access application in front of the public admin path (the app
fetches its signing keys from `<team>.cloudflareaccess.com`). All three are
covered in [`docs/operations/deployment.md`](docs/operations/deployment.md) and
[`docs/infrastructure/cloudflare-rules.md`](docs/infrastructure/cloudflare-rules.md).

### Installation — Docker Compose

```bash
git clone <repository-url> pelicanpass
cd pelicanpass
npm ci
cp .env.example .env
```

**Generate the two secrets before anything else.** The shipped placeholders fail
validation in _every_ environment, including development, and the app refuses to
boot if the two are equal:

```bash
openssl rand -hex 32   # → PASS_SECRET
openssl rand -hex 32   # → ADMIN_PASSWORD_PEPPER
```

Then set `EVENT_ID` (required, no default — it scopes every attendee query) and
`SITE_HOST` (Compose refuses to start without it), and replace every `change-me`
value — `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PASSWORD`,
`POSTGRES_MIGRATOR_PASSWORD`, `POSTGRES_READONLY_PASSWORD` and `REDIS_PASSWORD`.
The three role passwords must match `^[A-Za-z0-9]{12,}$`, which `01-roles.sh`
enforces: `npm run migrate` interpolates them into a `DATABASE_URL`, and
punctuation breaks it.

Bring up the database first and confirm the role provisioning ran — it only runs
on a freshly initialised data directory:

```bash
docker compose up -d db
docker compose logs db | grep 01-roles
```

**Run migrations inside a container.** The `data` network is `internal`, so `db`
does not resolve from the host and a bare `npm run migrate` will hang:

```bash
docker compose run --rm app npm run dev:migrate
```

This step is not optional. `01-roles.sh` deliberately grants nothing on
`attendees` — the column-level grants live in `migrations/005_app-role-grants.ts`,
so the app fails every query until migrations have run.

Start the stack:

```bash
docker compose up
```

Create the first administrator. There is no sign-up and no seeded account:
migration `013` withholds `INSERT` on `admins` from the app role, so accounts can
only be created from a shell, connecting as the migrator role. On the
development stack that shell is `app`; in production it is `migrate`
(`docker compose -f compose.prod.yml run --rm migrate node scripts/admin/create-admin.ts …`).

```bash
docker compose exec app node scripts/admin/create-admin.ts \
  --username <name> --scopes attendees:read,attendees:write,metrics:read
```

`--username` is a plain handle (`[a-z0-9._-]`) or an email address, up to 64
characters and stored lowercased. The password is prompted twice, never echoed
and never passed as a flag.

For test data, `docker compose exec app node scripts/db/seed.ts --reset` loads a
repeatable roster that draws entitlements from the approved redemption options. For a
single attendee, [`docs/operations/db-cheatsheet.md`](docs/operations/db-cheatsheet.md) has the exact
`INSERT` — `event_id` is `NOT NULL` with no default and must match your
`EVENT_ID`.

### Development stack

Development runs inside Compose too. The dev `app` service runs `npm run dev` —
the server under `node --watch`, the esbuild client watcher and the i18n
catalog watcher, concurrently — against a bind-mounted source tree.
`node --watch` restarts only for files the server imports, so after editing a
view under `src/web/views` or a Markdown file under `src/web/content`, restart
the server by hand (for example `docker compose restart app`). There is no
host-only mode: `data` is `internal` and nothing publishes a port, so a process
on the host cannot reach `db` or `cache`.

The dev stack carries the same tunnel, proxy and tailnet path as production, so
the admin surface's network gating can be verified locally. The two stacks run
side by side on one host on separate subnets; see
[`docs/operations/deployment.md`](docs/operations/deployment.md).

### Environment

Only what is needed to boot is listed. `.env.example` is the real reference — it
is ~800 commented lines covering all 82 variables, including the rate-limit tiers
and the alerting configuration.

| Variable                                            | Required   | Notes                                                                                |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `APP_URL`                                           | yes        | Public URL; used for same-origin checks                                              |
| `SITE_HOST`                                         | yes        | Bare public hostname; Compose refuses to start without it                            |
| `EVENT_ID`                                          | yes        | Scopes every attendee query                                                          |
| `CHECKIN_QR_TOKEN`                                  | yes        | 10–32 alphanumerics, `openssl rand -hex 16`; see `npm run qr:urls`                   |
| `PASS_SECRET`                                       | yes        | 64+ hex chars. Must differ from the pepper                                           |
| `ADMIN_PASSWORD_PEPPER`                             | yes        | 64+ hex chars, never stored in Postgres                                              |
| `POSTGRES_HOST` `_DB` `_USER` `_PASSWORD`           | yes        | The app role — no DDL, no superuser                                                  |
| `POSTGRES_SUPERUSER` `_PASSWORD`                    | yes        | Initialises the data directory and runs `01-roles.sh`                                |
| `POSTGRES_MIGRATOR_USER` `_PASSWORD`                | yes        | Owns the schema; migrations, seeding and the admin CLI                               |
| `POSTGRES_READONLY_USER` `_PASSWORD`                | yes        | Exports and inspection                                                               |
| `REDIS_HOST` `REDIS_PASSWORD`                       | yes        | Sessions, limiters, counters                                                         |
| `TURNSTILE_SITE_KEY` `TURNSTILE_SECRET`             | yes        | Check-in captcha                                                                     |
| `TURNSTILE_ADMIN_SITE_KEY` `TURNSTILE_ADMIN_SECRET` | yes        | Admin login captcha                                                                  |
| `TUNNEL_TOKEN`                                      | production | Cloudflare Tunnel                                                                    |
| `TS_AUTHKEY` `TS_HOSTNAME`                          | production | Tailscale sidecar; the key only on first registration                                |
| `CF_ACCESS_TEAM_DOMAIN` `CF_ACCESS_AUD`             | production | Access verification; unset, the public admin path is refused                         |
| `EVENT_START_AT`                                    | if landing | Must carry an explicit UTC offset                                                    |
| `WHATSAPP_*`                                        | if enabled | See [`docs/features/whatsapp-integration.md`](docs/features/whatsapp-integration.md) |
| `SURVEY_OPENS_AT`                                   | if enabled | Required once either `SURVEY_*_ENABLED` is on                                        |
| `ADMIN_URL`                                         | no         | Tailnet URL; accepted as a second same-origin                                        |
| `LANDING_ENABLED`                                   | no         | Pre-event countdown curtain, default `false`                                         |
| `EVENT_CLOSES_AT`                                   | no         | Post-event closing page from this instant; UTC offset required                       |
| `PASS_WELCOME_SCHEDULE`                             | no         | Default `phase@instant` list; `/admin/pass` overrides it                             |
| `TRUSTED_IPS`                                       | no         | Venue addresses that get the relaxed rate-limit tier                                 |
| `LOG_FILE_DIR`                                      | no         | Rotating `warn`+ NDJSON; empty disables                                              |
| `DISCORD_WEBHOOK_URL` `_CRITICAL`                   | no         | Alert delivery; empty sends nothing, rules still log                                 |
| `ALERT_ENABLED` `ALERT_DEDUP_TTL`                   | no         | Delivery switch, default `true`; per-signature quiet window `10m`                    |

In production each service receives only the variables it reads, named under
`environment:` in `compose.prod.yml`: `app` the server's, `migrate` the migrator
credentials, `db`, `tunnel` and `vpn` their own. A new setting has to be listed
there as well as in `src/config/env.ts`. Changing one needs
`docker compose up -d --force-recreate app` — a `restart` will not pick it up.
(The development `app` mounts the checkout, `.env` included, and loads all of it.)

---

## Usage

**Manage administrators** — all four scripts connect as the migrator role. In
production they run in the `migrate` service, which holds those credentials and
none of the server's secrets (add `--build` after a pull, as for migrations); the
development stack runs them on `app`:

```bash
docker compose -f compose.prod.yml run --rm migrate node scripts/admin/list-admins.ts
docker compose -f compose.prod.yml run --rm migrate node scripts/admin/set-admin-scopes.ts --username <name> --scopes metrics:read
docker compose -f compose.prod.yml run --rm migrate node scripts/admin/set-admin-scopes.ts --username <name> --disable   # or --enable
docker compose -f compose.prod.yml run --rm migrate node scripts/admin/set-admin-password.ts --username <name>
```

On the development stack, replace `-f compose.prod.yml run --rm migrate` with `exec app`.

`run` allocates a terminal, which `create-admin.ts` and `set-admin-password.ts`
need for the hidden password prompt. `migrate` has no entrypoint, so the command
replaces its default `npm run migrate` as written.

Scope and disable changes take effect on the admin's next request — the gates
re-read Postgres rather than trusting the session. The seventeen scopes are
defined once in `src/constants/admin-scopes.ts` and read by the permission
middleware, the nav and the CLI. Migration `013` built its `CHECK` constraint
from that file; the later scope migrations write their lists out on purpose, so
that a migration's meaning cannot change after it has run.

**Preview a closed check-in window** — with `LANDING_ENABLED=true`, the curtain
sits in front of every attendee route until the window opens (by default,
volunteers 4 hours before the event and participants 30 minutes, set by
`CHECKIN_OPENS_BEFORE_*`). To rehearse the real flow before then, set
`LANDING_BYPASS_TOKEN` and append `?preview=<token>` once; it is exchanged for a
cookie and redirected out of the URL.

**Watch the event** — `/admin/metrics` polls a snapshot every five seconds: door
throughput with participant check-ins by ticket prefix and the ticket limit
status, redemptions, dependency health, error rates, latency percentiles and
live limiter rows. It degrades per panel rather than throwing, so a Redis outage
renders empty Redis panels — which is itself the diagnosis. When the snapshot
cannot answer at all it falls back to `/readyz` and names the failing dependency.

**After the event** — read [`docs/security/data-retention.md`](docs/security/data-retention.md)
first: it inventories every artifact holding personal data and is the
authoritative procedure. In order, and with no second attempt once the volume is
gone:

```bash
# Compose reads .env for itself; it does not export it to this shell.
set -a; . ./.env; set +a
echo "migrator=$POSTGRES_MIGRATOR_USER readonly=$POSTGRES_READONLY_USER db=$POSTGRES_DB event=$EVENT_ID"
#    none empty, and event is the real id, not the .env.example placeholder

# 0. Forget who answered the questionnaire, and redact names and phones — as the migrator
docker compose exec -T db psql -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" < scripts/db/purge-attendees.sql

# 1. Export what is kept — as the read-only role
docker compose exec -T db psql -U "$POSTGRES_READONLY_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/export-results.sql > checkin-results.csv
docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
  --audience participant > survey-participant.csv
docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
  --audience volunteer > survey-volunteer.csv

# 2. Check the exports, then destroy the event's data
docker compose down -v
```

Then delete every `pg_dump` taken during the event, wherever it was copied to.
`scripts/db/purge-phone.sql` is only for the case where a full dump is kept.

---

## Development

```bash
npm run check      # format, lint, typecheck, i18n, questionnaire and redemption checks, unit tests — the pre-push gate
npm run dev        # server + client bundler + i18n catalog watcher (run by the dev app container)
npm run build      # production client bundle
npm run check:docker-context  # Docker build context carries no secrets or local state (needs Docker)
npm run lint:fix
npm run format
```

`typecheck` covers two projects — the backend and the browser bundle — sharing
`tsconfig.base.json`. **`lint` is not optional**: it is the only gate that catches
a stale `.js` import specifier, which type-checks clean and then fails at boot.

Strictness actually in force: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `erasableSyntaxOnly` and `verbatimModuleSyntax`,
with typescript-eslint on `strictTypeChecked`. `erasableSyntaxOnly` is a
consequence of running `.ts` directly — `enum`, `namespace` and parameter
properties do not erase to nothing, so they are compile errors by design. The
alternatives are in
[`docs/development/typescript-conventions.md`](docs/development/typescript-conventions.md).

**House style:** non-trivial modules open with a JSDoc block explaining _why_ —
naming the alternative rejected, and the measurement where one was taken. Match
it. A comment restating what the next line does is noise; a comment recording the
option that was considered and dropped is the thing that stops it being
reintroduced in six months.

**Client build** — `scripts/build-client.ts` produces per-page esbuild entries
mirroring the source paths, with content-hashed chunks. Two decisions are
recorded there: `keepNames: true` was bought instead of source maps (+2.8%
gzipped, measured) because a minified stack trace naming `t`, `n`, `o` is
indistinguishable from no stack trace; and CSS is flattened per document because
`main.css`'s 24 `@import`s would otherwise be 24 _serial_ round trips on venue
wifi.

`npm test`, part of `npm run check`, runs the unit tests: pure policy,
validation, configuration and client logic, with no database or Redis. What they
cannot see still depends on the 16-step acceptance checklist in
[`docs/operations/deployment.md`](docs/operations/deployment.md) — network isolation, forged client
IP, rate-limit thresholds, degraded-Redis behaviour — the pass and questionnaire
rehearsals in the same runbook, and `scripts/telemetry/smoke.ts` for the alert
path.

Two suites need Docker and skip, rather than fail, where it or their image is
missing: `scripts/caddyfile.test.ts` (adapts the `Caddyfile` with Caddy) and
`scripts/db/export-results.test.ts` (runs `export-results.sql` against Postgres).
They run with `--pull=never`, so the pinned images must already be cached; the
pins are written in the test files and match `compose.yml` and `compose.prod.yml`.
This pulls whatever the tests pin:

```bash
grep -ho "'\(caddy\|postgres\):[^']*'" scripts/caddyfile.test.ts scripts/db/export-results.test.ts |
  tr -d "'" | xargs -n1 docker pull
```

A skip shows in the `ℹ skipped` line of the summary, not as a failure, and the
repo has no CI. `npm run check` must report `skipped 0` before a release is cut;
see [Updating pinned images](docs/operations/deployment.md#updating-pinned-images)
for bumping the pins.

---

## Roadmap

- [x] Check-in flow, attendee pass, redemption counter, live raffle
- [x] Admin shell, roster editor, volunteer lookup, metrics dashboard
- [x] Admin redemptions screen, with audited corrections
- [x] Security remediation — 14 of 15 audit findings closed in code
- [x] Observability: counters, durable events, alert rules, client error ingestion
- [x] Experience questionnaire, with admin override and CSV export
- [x] WhatsApp ticket delivery, with delivery receipts
- [x] Message catalogs and copy management for every screen
- [x] Cloudflare Access in front of the public admin path
- [x] Overload resilience: load shedding, request deadlines, safe re-taps
- [x] Check-in session rotation in a single Redis transaction
- [x] Volunteer permissions screen and pass access tiers
- [x] Ticket limit for the attendees editor
- [x] Landing fallback and warm standby for the day
- [ ] **Integration tests** against Postgres and Redis — the acceptance checklists are manual today
- [ ] Result exports (`/admin/exports`) and roster import (`/admin/import`) ([exports plan](docs/development/admin-export-plan.md), [import plan](docs/development/admin-import-plan.md))
- [ ] Admin management UI (`/admin/admins`) — CLI-only for now
- [ ] Configurable events: per-event settings, branding and copy in `/admin` ([plan](docs/development/roadmap.md))
- [ ] Faster QR scanner: native `BarcodeDetector` with a WebAssembly fallback ([plan](docs/development/qr-scanner-speed-plan.md))

---

## Documentation

`docs/` holds the reasoning behind the decisions summarised above. At the repository root,
[`SECURITY.md`](SECURITY.md) covers reporting a vulnerability and
[`CONTRIBUTING.md`](CONTRIBUTING.md) the branch, commit and check workflow.

Every document is indexed, grouped by area (operations, infrastructure, performance, features,
security and privacy, development), in [docs/README.md](docs/README.md).
`docs/reports/` holds the post-event report.

---

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE).

## Disclaimer

This is a portfolio project, built pro bono for a single event. It is provided **as is**, with no
support, maintenance or service commitment of any kind; the warranty and liability terms are those
of the [MIT License](LICENSE).

Anyone who deploys this code is the operator of that deployment, and the data controller for any
personal data it processes. The operator alone is responsible for its configuration, security,
compliance with applicable law (LGPD, GDPR or otherwise), and for handling any bug, outage or breach
that occurs in it. The documentation describes one deployment at one point in time; it is not a
guarantee that any configuration is secure or fit for another purpose.

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability and
[`docs/security/incident-response.md`](docs/security/incident-response.md) for handling an incident in your own
deployment.

## Contact

Joshua Porter — [joshuaporter.dev@outlook.com](mailto:joshuaporter.dev@outlook.com)

## Acknowledgments

- [Claude Code](https://claude.com/claude-code) — the author designed the
  check-in flow, chose the infrastructure and planned how every feature behaves.
  Claude Code wrote and tested most of the code for those features, in phases
  the author planned and reviewed, designed the UI apart from the branding, and
  helped research the choice between approaches.
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template)
- [Libre Franklin](https://github.com/impallari/Libre-Franklin) and
  [Material Symbols](https://github.com/google/material-design-icons), both
  vendored and subsetted — licenses ship alongside them in
  `src/web/public/assets/fonts/`
- [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible),
  [`pino`](https://github.com/pinojs/pino) and
  [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)

[node-badge]: https://img.shields.io/badge/Node.js-24+-5FA04E?style=for-the-badge&logo=node.js&logoColor=white
[node-url]: https://nodejs.org
[ts-badge]: https://img.shields.io/badge/TypeScript-6.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[ts-url]: https://www.typescriptlang.org
[express-badge]: https://img.shields.io/badge/Express-5-000000?style=for-the-badge&logo=express&logoColor=white
[express-url]: https://expressjs.com
[pg-badge]: https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white
[pg-url]: https://www.postgresql.org
[redis-badge]: https://img.shields.io/badge/Redis-8-FF4438?style=for-the-badge&logo=redis&logoColor=white
[redis-url]: https://redis.io
[docker-badge]: https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white
[docker-url]: https://www.docker.com
[license-badge]: https://img.shields.io/badge/License-MIT-blue?style=for-the-badge

---
