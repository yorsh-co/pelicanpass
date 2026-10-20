# Rate limiting

Every application-layer rate limiter: what it keys on, how large it is, where
it is charged, and why it is that size. Edge controls (Cloudflare's single rate
limiting rule, custom rules, Access) are in
[`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) and are not repeated here.

**The code is authoritative.** Every limiter lives in
[`src/middleware/rate.middleware.ts`](../../src/middleware/rate.middleware.ts), and
every quota in
[`src/config/rate-limits.ts`](../../src/config/rate-limits.ts), keyed by its
prefix. If this document disagrees with them, this document is wrong. That is
the opposite of the stance `cloudflare-rules.md` takes, and deliberately so: a
dashboard cannot be diffed, so its intent has to be written down; a limiter's
quota is one line in a reviewed file. What this document adds is the view the
code cannot give in one place — every limiter side by side, and every route's
chain in order.

The quotas below are the defaults. `RATE_LIMIT_OVERRIDES` can replace any of
them at boot; see [Overriding a quota](#overriding-a-quota).

The document is organised **by limiter**, because the Redis prefix is the name
everything else uses: the metrics panel's rows, the `Rate limiter consumed` log
line, and the Redis key an operator deletes to clear a lockout. The
[route matrix](#route-matrix) is the index for the other question — "which
limiter refused this request?"

---

## Principles

Each of these is referred to by name further down.

**Key on what an attacker cannot rotate.** A resolved session ID, an attendee
ID, a username or a single global key. Never a raw cookie — a client rotating
random cookies would mint a fresh budget per request and a Redis key with it.
Session limiters key on a SHA-256 digest of `req.sessionIds[type]`, which
`resolveSessions` writes only once the store has confirmed the session. The
digest keeps live session IDs out of Redis and off the metrics panel, whose
busiest-keys list shows only addresses and global keys verbatim.

**Cost control is not guessing control.** Every per-IP limiter bounds _cost_:
Redis and Postgres work per request. None of them stops ticket guessing,
because at an in-person event one address is the whole room. What stops
guessing is the four [failure budgets](#failure-budgets), none of which keys on
IP.

**Sized for NAT.** Venue WiFi puts the room behind one address, and Brazilian
carrier CGNAT puts an unpredictable slice of it behind others that cannot be
listed in advance. One check-in costs 3 requests at best and about 6 in
practice. Every IP quota below was sized against that, and `TRUSTED_IPS` gives
the known venue addresses a relaxed tier.

**Pacing is not a control.** `checkinEntryPacingLimiter` keys on a cookie the
client owns. It exists so one runaway honest client behind NAT cannot eat the
room's shared IP budget, not to stop anyone deliberate.

**Escapes are deliberate, and each is argued.** Some routes skip a limiter they
would otherwise inherit: the pass poll, the survey submit, the WhatsApp
callback, and the two admin polls. Each time, the limiter being escaped was
never the boundary for that route, only the thing that would break first. The
reasoning sits at the mount site; the [route matrix](#route-matrix) marks each
one.

**Fail open, with insurance.** A store failure is logged and the request is let
through. Before that happens, every Redis-backed limiter falls back to an
in-process twin with the same quota — see
[Redis outage](#redis-outage).

---

## Layers

A request meets four layers, in this order.

1. **Cloudflare.** One rate limiting rule, reserved for `/checkin` at 600/60s,
   keyed on plain IP — **not yet created** (see
   [`cloudflare-rules.md` § Rate limiting rule](../infrastructure/cloudflare-rules.md#rate-limiting-rule--not-yet-created)).
   It is a denial-of-service ceiling that sits at or above the application's
   own trusted tier, so it never becomes the binding limit at the venue.
2. **Caddy establishes `req.ip`.** Every IP-keyed limiter is only as good as
   this. On the public vhost, `{client_ip}` reads `CF-Connecting-IP` only from
   `EDGE_SUBNET` (cloudflared) and is forwarded as `X-Forwarded-For`; Express
   runs with `trust proxy` set to `1`. On the `:8080` tailnet listener, the
   Tailscale sidecar _sets_ `X-Forwarded-For` to the device's tailnet address,
   so **each operator gets their own key**. If `EDGE_SUBNET` is blank outside
   compose, every public client shares cloudflared's address — one bucket for
   the whole event. The `Caddyfile` carries the full argument.
3. **The Access gate, on the admin paths only.** `requireAccessAssertion`
   (`app.ts`) runs on `/admin` and `/api/v1/admin` before any router, so a
   refused assertion costs no limiter point. That is acceptable because the
   public path cannot be flooded past it: Cloudflare Access refuses
   unauthenticated callers at the edge, and Caddy refuses anything that did not
   come through cloudflared. The tailnet listener skips the gate. A forged
   `kid` cannot amplify into key fetches either, since jose refetches the
   signing keys at most once every 30 seconds. It also means every request an
   admin limiter counts, `rl:ip:admin-login` included, has already passed Access
   or come through the tailnet.
4. **The application limiters** below.

---

## Limiter catalogue

Quotas are `points / seconds`. **Block** is `blockDuration`: once over quota,
the key stays refused for that long regardless of the window. **Kind** is one of
_cost_, _pacing_ or _control_ (see [Principles](#principles)).

### Per-IP, tiered

Built by `createTieredIpLimiter`. Two buckets per limiter: the strict one for
everyone, and a `:trusted` one for addresses matching `TRUSTED_IPS`. The metrics
panel shows them as separate rows.

| Prefix                | Strict | Trusted  | Kind | Charged at                                  |
| --------------------- | ------ | -------- | ---- | ------------------------------------------- |
| `rl:ip`               | 300/60 | 2 000/60 | cost | Every `/api/v1` request, bar the exemptions |
| `rl:ip:web`           | 300/60 | 1 000/60 | cost | Every request the web router sees           |
| `rl:ip:checkin-entry` | 60/60  | 600/60   | cost | `GET /checkin`                              |
| `rl:ip:admin-login`   | 10/60  | 30/60    | cost | `/api/v1/admin/auth`                        |

**`rl:ip` — `ipLimiter`.** The API's baseline. 300 carries roughly 50 arrivals a
minute from one address. It was 60, and was raised knowingly because it was
never the boundary. Exempt: `/attendee/pass`, `/attendee/status` and `/survey`
once the attendee session resolves, and the WhatsApp callback prefix (`IP_LIMIT_EXEMPT` in
[`src/api/index.ts`](../../src/api/index.ts)). A request on those paths
without a resolved session is charged `rl:ip` after `resolveSessions`
instead, so an anonymous flood there is bounded like any other path's.

**`rl:ip:web` — `webLimiter`.** The web router's baseline: every render still
costs a Redis session lookup. Mounted first on the web router, so it covers
`/privacy`, `/terms`, the manifest, every admin page, and unmatched paths. It
was 100, and was raised to 300 on the load test's evidence: after a raffle draw
the room opens its pass about 1.2 times a phone in a minute, so 100 refused
everyone past roughly 83 phones on one carrier address, which `TRUSTED_IPS`
cannot cover. A room split over two carriers lost half its raffle opens at 100
and none at 300, which carries about 250 phones per address
([`load-test-results.md`](./load-test-results.md), Limiter balance).

**`rl:ip:checkin-entry` — `checkinEntryIpLimiter`.** `GET /checkin` takes an
attacker-controlled `?t=` or `?k=` and hits Postgres on every request. A `?t=`
entry costs **two points**: the handler consumes the token and 303s back to a
bare `/checkin` through the same limiter, so 60 is 30 link arrivals a minute.
A link opened from another site (`Sec-Fetch-Site: cross-site`) costs **three**:
the `GET` only draws a "Continuar" page, its button posts the token to
`POST /checkin` (the same limiter, behind `requireSameOrigin`), and the redirect
that follows is a bare `GET`.
Refusals here come from middleware, so they render as a plain 429 page rather
than the route's redirect-on-error.

**`rl:ip:admin-login` — `adminLoginLimiter`.** `adminSessionLimiter` cannot
cover login: there is no session before one. Mounted _before_
`requireAdminLoginCaptcha`, so an IP flood is refused before it costs a
Turnstile siteverify.

### Per-session

Keyed on a digest of the session ID `resolveSessions` confirmed, so they must
be mounted after it. All are _cost_ controls against a leaked or scripted
session.

| Prefix                      | Quota | Keyed on                     | Charged at                                                                       |
| --------------------------- | ----- | ---------------------------- | -------------------------------------------------------------------------------- |
| `rl:session:checkin`        | 20/60 | Check-in session             | `/api/v1/checkin/*` below the two entry steps                                    |
| `rl:session:attendee`       | 30/60 | Attendee session             | `/api/v1/attendee`, `/api/v1/survey`; web `/`, `/pass`, `/staff`, `/raffle` |
| `rl:session:staff`          | 60/60 | Attendee session (volunteer) | `/api/v1/staff`, `/api/v1/raffle`                                                |
| `rl:session:admin`          | 20/60 | Admin session                | `/api/v1/admin/*` except the three polls                                         |
| `rl:session:admin:metrics`  | 60/60 | Admin session                | `/api/v1/admin/metrics`                                                          |
| `rl:session:admin:whatsapp` | 60/60 | Admin session                | `GET /api/v1/admin/whatsapp/runs/current`                                        |
| `rl:session:admin:redemptions` | 60/60 | Admin session | `GET /api/v1/admin/redemptions/summary` |

**`rl:session:staff` — `staffSessionLimiter`.** There is no staff session; the
surface runs on the volunteer's attendee session. The separate prefix keeps a
volunteer hammering the scanner from spending the quota their own pass polls
against. 60 is about thirty handovers a minute from one phone.

**`rl:session:admin` — `adminSessionLimiter`.** Tighter than attendee because
admin traffic is low-volume and high-value. The roster and the volunteer lookup
stay inside it by being server-rendered from submitted forms, which cost
`rl:ip:web` instead; only their writes cross the API (see
`admin.attendees.controller.ts` and `admin.lookup.controller.ts`).

**`rl:session:admin:metrics`, `rl:session:admin:whatsapp` and
`rl:session:admin:redemptions`.** The dashboard polls every 5s (12/min), the
sender every 3s (20/min) and the redemptions totals every 10s (6/min). Any of
them would consume a large share of `rl:session:admin` on its own and leave the
operator's real work — a stop button, an undo — answering 429. Each has its own
prefix so the screens open together do not starve each other. What bounds these routes is the admin session and scope
check, not the quota.

**Mount order is load-bearing.** All three polls are registered _above_ the
`/admin` mount in `src/api/index.ts`. Registered below it, Express would match
`/admin` first and charge `rl:session:admin` anyway. The WhatsApp and
redemptions polls are exact `router.get`s, not `use`s, so the writes under the
same prefixes are not charged twice.

### Cookie-keyed pacing

| Prefix                          | Quota | Keyed on                                             | Kind   | Charged at                                   |
| ------------------------------- | ----- | ---------------------------------------------------- | ------ | -------------------------------------------- |
| `rl:session:checkin_session_id` | 20/60 | Digest of the unresolved `checkin_session_id` cookie | pacing | `POST /api/v1/checkin/ticket`, `POST .../qr` |

**`checkinEntryPacingLimiter`.** These two steps _issue_ the check-in session,
so they run before `resolveSessions` and the unresolved cookie is all there is
to key on, digested like every session key. **The prefix misleads**: it sits
under `rl:session:` but is not session-keyed, which is why the panel badges it
`cookie`. A client that drops its cookie gets a fresh budget.

### IP + global pairs

Consumed from controllers, not mounted as middleware, because the global tier
keys on a constant that `createLimiterMiddleware` cannot express. The IP tier is
charged first; the first refusal wins.

| Prefix                       | Quota    | Keyed on | Charged at                                       |
| ---------------------------- | -------- | -------- | ------------------------------------------------ |
| `rl:ip:client-errors`        | 60/60    | IP       | `POST /api/v1/client-errors`                     |
| `rl:global:client-errors`    | 300/60   | Global   | `POST /api/v1/client-errors`                     |
| `rl:ip:whatsapp-webhook`     | 600/60   | IP       | `POST` to the WhatsApp callback, before the HMAC |
| `rl:global:whatsapp-webhook` | 1 200/60 | Global   | `POST` to the WhatsApp callback, before the HMAC |

**Client errors — `consumeClientErrorBudget`.** The realistic threat is a bad
deploy making seven hundred phones report the same error at once, which is a
disk problem that only a global cap answers. The IP tier is 60, not the 5 one
device needs, because of NAT: at 5 the whole venue would share one phone's
budget and the >20/min client-error alert could never fire. The endpoint is for
**detection, not collection**. It also still pays `rl:ip`.

**WhatsApp callback — `consumeWhatsappWebhookBudget`.** Meta delivers from many
addresses, so the global tier does the real work. Sized against a run (700
recipients ≈ 2 100 status events in ~12 minutes) with several times headroom,
because **a 429 to Meta is a redelivery, not a refusal**. Our own throttle
causing a redelivery storm is worse than the traffic it bounds. Charged before
signature verification, so a flood costs a Redis increment rather than an HMAC.
This pair is the whole per-request throttle for this path: it is exempt from
`rl:ip`, and the one Cloudflare rule is spent on `/checkin`. It covers the `GET`
verification handshake as well as receipts. Every refused handshake writes a
`warn` line to the durable log, so leaving it unmetered would have made it an
unbounded disk writer. Meta sends one per subscription save.

### Failure budgets

Charged from services only once an outcome is known to be a failure, so honest
traffic — overwhelmingly successful — barely touches them. These are the
guessing controls, and none keys on IP.

| Prefix                              | Quota  | Block | Keyed on                | Charged when                                 |
| ----------------------------------- | ------ | ----- | ----------------------- | -------------------------------------------- |
| `rl:global:checkin-entry-failures`  | 30/60  | —     | Global                  | A ticket or QR lookup fails                  |
| `rl:attendee:verification-failures` | 10/900 | 900 s | Attendee being verified | A verification code is wrong                 |
| `rl:admin:login-failures`           | 10/900 | 900 s | Username attempted      | **Every** login attempt; refunded on success |
| `rl:staff:lookup-failures`          | 15/300 | 300 s | Volunteer's attendee ID | A well-formed staff lookup code misses       |

**Check-in entry — `consumeCheckinEntryFailure`.** Charged by
`CheckinService` when a link token (`GET /checkin?t=`, or `POST /checkin`), QR token (`?k=`),
`POST /ticket` or `POST /qr` lookup fails. **Exhaustion does not refuse
anyone.** It raises a captcha for every caller until the window refills, read
through `isCheckinFailureBudgetExhausted` by `requireCaptchaIfFlagged` on
`POST /ticket` and by the service. Returning 429 would let an attacker close the
door on the queue by failing on purpose; a Turnstile costs a script far more
than a person. The state is in Redis rather than the session so discarding a
cookie does not clear it. The rules loop alerts when it flips.

`POST /checkin/presence` is deliberately not charged to this budget. The session
is already bound to one verified attendee and the request carries no input, so a
"not marked present yet" answer is not a guess; charging it would let a busy
help desk raise a captcha for every attendee at the door. Each such answer
counts toward the session's QR lockout instead (10, shared with scans).

**Verification — `consumeVerificationFailure`.** One legitimate person per
attendee, which is what makes 10 in 15 minutes safe. The session's own
attempt counter drives the "attempts left" copy but lives behind a droppable
cookie; this is the budget that gates. Exhaustion is a 429.

**Admin login — `consumeAdminLoginFailure` / `resetAdminLoginFailures`.**
Charged **up front**, before the account lookup and scrypt, so a refused
attempt costs a Redis round trip instead of ~100 ms of CPU. Refunded (the key
is deleted) on success, so only failures accumulate. That ordering is why
`requireAdminLoginCaptcha` sits in front of it: otherwise anyone with a username
could lock that volunteer out without solving anything. Exhaustion is a 429, a
security event, and a critical alert; the username is in the log line, not the
alert.

**Staff lookup — `consumeStaffLookupFailure`.** `/staff/lookup` resolves a typed
code straight to an attendee, which is an oracle. Malformed codes are rejected
as a `ValidationError` without charging, so an honest mistype costs nothing.
Five minutes rather than fifteen because this can lock out a counter at a live
event.

### Spend

Charged from a service when a paid message is about to be attempted. A refusal
never refuses the request that caused it: it drops the message and says so.

| Prefix                   | Quota  | Keyed on | Charged when                                                               |
| ------------------------ | ------ | -------- | -------------------------------------------------------------------------- |
| `rl:admin:whatsapp-door` | 30/600 | Admin ID | A door message passed the lock, switch and phone checks; before the budget |

**Door message — `consumeWhatsappDoorBudget`.** Every attendee created in
`/admin/attendees` with the message ticked is a paid WhatsApp send, and the
operator may not know that. `WHATSAPP_BUDGET_USD` is the hard stop; this keeps
one account from reaching it in minutes. Keyed on the admin ID, not the
session, so signing in again buys nothing. A refusal creates the attendee
without the message, and the form tells the operator why.

### Unregistered: `/readyz`

`readyzRateLimit`: 300/60 per IP, **in process only** (`RateLimiterMemory`). A
Redis-backed limiter would have swapped the probe's Redis `PING` for an `INCR`
and protected nothing. The real protection is the one-second cache in
`src/shared/telemetry/probes.ts`; this only bounds a runaway loop. It fails open,
is not on the metrics panel (the panel's own fallback calls it), and is served
only on the tailnet listener.

---

## Route matrix

The limiters a request passes, in the order it passes them, then any failure
budget its handler can charge. Middleware that is not a limiter (content-type,
same-origin, session checks, captcha) is omitted.

### API — `/api/v1`

| Route                                      | Limiters, in order                                                                | Failure budget |
| ------------------------------------------ | --------------------------------------------------------------------------------- | -------------- |
| `POST /client-errors`                      | `rl:ip` → `rl:ip:client-errors` → `rl:global:client-errors`                       | —              |
| `GET`, `POST /whatsapp/webhook/<secret>`   | `rl:ip:whatsapp-webhook` → `rl:global:whatsapp-webhook`                           | —              |
| `POST /checkin/ticket`, `POST /checkin/qr` | `rl:ip` → `rl:session:checkin_session_id`                                         | checkin-entry  |
| `POST /checkin/verification`               | `rl:ip` → `rl:session:checkin`                                                    | verification   |
| `POST /checkin/presence`                   | `rl:ip` → `rl:session:checkin`                                                    | —              |
| `POST /checkin/reset`                      | `rl:ip` → `rl:session:checkin`                                                    | —              |
| `POST /admin/auth/login`                   | `rl:ip` → `rl:ip:admin-login`                                                     | admin login    |
| `/admin/metrics/*`                         | `rl:ip` → `rl:session:admin:metrics`                                              | —              |
| `GET /admin/whatsapp/runs/current`         | `rl:ip` → `rl:session:admin:whatsapp`                                             | —              |
| `GET /admin/redemptions/summary` | `rl:ip` → `rl:session:admin:redemptions` | — |
| `/admin/*` (everything else)               | `rl:ip` → `rl:session:admin`                                                      | —              |
| `GET /attendee/pass`                       | `rl:session:attendee` (**exempt from `rl:ip`**); anonymous: `rl:ip`, then refused | —              |
| `GET /attendee/status`                     | `rl:session:attendee` (**exempt from `rl:ip`**); anonymous: `rl:ip`, then refused | —              |
| `/attendee/*` (everything else)            | `rl:ip` → `rl:session:attendee`                                                   | —              |
| `POST /survey`                             | `rl:session:attendee` (**exempt from `rl:ip`**); anonymous: `rl:ip`, then refused | —              |
| `POST /staff/lookup`                       | `rl:ip` → `rl:session:staff`                                                      | staff lookup   |
| `/staff/*`, `/raffle/*` (everything else)  | `rl:ip` → `rl:session:staff`                                                      | —              |
| Unmatched, outside a guarded mount         | `rl:ip` → `rl:ip:web`                                                             | —              |
| Unmatched, guarded mount, no session       | `rl:ip`, then refused                                                             | —              |
| Unmatched, guarded mount, valid session    | `rl:ip` → that mount's session limiter → `rl:ip:web`                              | —              |
| Unmatched, under `/whatsapp/webhook/`      | `rl:ip:web` (**exempt from `rl:ip`**)                                             | —              |

The API router has no catch-all, so an unmatched path falls through to the web
router, whose first middleware is `webLimiter`, before the 404. The exception is
a guarded mount — `/admin`, `/attendee`, `/survey`, `/staff`, `/raffle` and
`/checkin` — where a caller without the right session is refused by the session
check (or the check-in window gate) and never reaches the web router. A caller
with a valid session pays that mount's session limiter and then falls through
like any other. A path under
`/whatsapp/webhook/` with the wrong secret, or any path there while the webhook
is disabled, matches nothing but is still exempt from `rl:ip`, so it pays only
`rl:ip:web`.

Every `/admin/*` row, in this table and the next, runs behind the
[Access gate](#layers) first.

### Web and app-level

| Route                                     | Limiters, in order                  | Failure budget |
| ----------------------------------------- | ----------------------------------- | -------------- |
| Static assets, `/healthz`                 | none                                | —              |
| `/readyz` (tailnet only)                  | `readyzRateLimit`                   | —              |
| `/privacy`, `/terms`, `/site.webmanifest` | `rl:ip:web`                         | —              |
| `GET /checkin` (incl. `?t=`, `?k=`)       | `rl:ip:web` → `rl:ip:checkin-entry` | checkin-entry  |
| `POST /checkin` (continue page)           | `rl:ip:web` → `rl:ip:checkin-entry` | checkin-entry  |
| `/admin/login`, every `/admin/*` page     | `rl:ip:web`                         | —              |
| `/`, `/pass`, `/staff`, `/raffle`    | `rl:ip:web` → `rl:session:attendee` | —              |
| Anything else (404)                       | `rl:ip:web`                         | —              |

Admin pages are full-page loads and cost `rl:ip:web` only, not
`rl:session:admin` — the reason several admin screens were built as forms.

There is no staff session: `SessionType` is only `checkin`, `attendee` and
`admin`, and both staff surfaces are keyed on the volunteer's attendee session.
The web `/staff` and `/raffle` pages charge `rl:session:attendee`. The staff and
raffle _APIs_ charge a separate budget under the `rl:session:staff` prefix, so
scanning does not spend the quota the volunteer's own pass polls against.

---

## Refusal and failure behaviour

**Over quota.** Every limiter answers with a `RateLimitError`: status 429, code
`RATE_LIMITED`, `details.retryAfterSeconds`, and a `Retry-After` header set by
`applyRateLimitHeader`. The API answers JSON; the web router renders the error
page with copy that names the wait in seconds or minutes
(`render-error-page.ts`). The one exception is the check-in entry failure
budget, which raises a captcha instead of refusing.

**Store failure.** A rejection that is not a `RateLimiterRes` is a store error,
not rate limiting. It is logged as `Rate limiter error` and the request
proceeds. `isCheckinFailureBudgetExhausted` answers `false` on error, so a store
failure never forces the whole door behind a captcha.

### Redis outage

`createInsuredLimiter` gives every Redis-backed limiter a `RateLimiterMemory`
twin with the same quota, which takes over when Redis is unreachable:

- It covers `get()` as well as `consume()`, so the global captcha flag keeps
  tracking failures counted by the same process.
- `blockDuration` is copied from the parent, so lockouts still apply.
- State is per process and lost on restart. `server.ts` runs unclustered, so the
  memory tier enforces the real quota, not a multiple of it.
- Deleting a Redis key does not clear the memory tier; during an outage only a
  restart does.
- Every attendee-facing page and API call needs Redis for its session, so
  with it unreachable the check-in, pass, staff and raffle pages and the
  `/api/v1` check-in, attendee, survey, staff and raffle calls answer
  `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` (`redisOutageToUnavailable`
  at the end of the web and API routers, and `resolveSessions`), not `500`,
  `401` or a redirect back to check-in. The request is logged at `warn`,
  because `/readyz` and the Redis client already report the outage; it still
  counts as `http.5xx`, so the 5xx alert and the door-stalled alert hear it. A
  shed `503` is counted apart as `http.shed`. The admin pages and API, and
  `/healthz` and `/readyz`, behave as before.

Measured with `cache` stopped (August 2026, before the `503` mapping, so requests answered `500`):

- Request latency fell from over 60 s with no response to 0.12 s once the client failed fast.
- `/healthz` stayed 200 and the process never exited (`RestartCount 0`).
- The memory tier still tripped the per-IP limit at exactly request 301 and the global entry-failure budget at 31,
  and `isCheckinFailureBudgetExhausted()` (a `get()`, not a `consume()`) stayed `true`, so the global captcha flag
  survives an outage.
- `docker compose start cache` recovered on its own, with no app restart.

---

## Operating

### `TRUSTED_IPS`

A comma-separated list of addresses and CIDR ranges that get the `:trusted`
tier on the four tiered limiters. It affects nothing else. Empty means everyone
is strict. An invalid entry **fails at boot** (`buildTrustedIpMatcher`), not at
the first request. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) matches IPv4 rules.

Add the venue's public address once it is known. When the metrics panel shows
the strict `rl:ip` row near its ceiling with one key dominating the busiest-keys
list, that is the remedy the panel exists to prompt.

The 17/10 event recorded no `429`. That does not say how close the limiters came
to their quotas, because successful requests are not counted per address ([event
report](../reports/event-2026-10-17.md#rate-limiting)).

### Metrics panel

Rows are seeded at boot from `limiterRegistry()`, so every registered limiter
has a row and its true ceiling before any traffic. A missing row means broken
instrumentation, not "no traffic yet". Each row shows consumed, refused and peak
per minute, plus the 20 busiest keys over a five-minute window (retention in
[`data-retention.md`](../security/data-retention.md)). The badge and tooltip come from the
`basis`, `keyedOn` and `protects` each limiter declares.

The panel is readable by any `metrics:read` administrator, so only address and
global keys are shown verbatim. Every other key, whether a session, cookie,
username, attendee, volunteer or admin ID, is shown as the first 12 hex
characters of its SHA-256 (`panelKey` in `src/middleware/limiter-keys.ts`).
That is enough to tell buckets apart and follow one across refreshes, and it
can't be replayed. A login-failure row therefore no longer names the account;
the `Admin login budget exhausted` log line does.

### Overriding a quota

Try [`TRUSTED_IPS`](#trusted_ips) first. It relaxes the room without loosening
the limiter for everyone else. When a ceiling itself is wrong, override it in
`.env` rather than cutting a release:

```sh
RATE_LIMIT_OVERRIDES=rl:ip=600/60, rl:ip:checkin-entry=120/60
```

```sh
docker compose up -d --force-recreate app
```

- **Format:** comma-separated `prefix=points/duration`, with duration in
  seconds. The prefix is the one the metrics panel shows, and a tiered
  limiter's trusted tier is its own entry (`rl:ip:trusted`). `readyz` is the
  one key that is not a Redis prefix.
- **Not `restart`.** The container's `environment` is fixed when it is created, so a
  restart keeps the old values.
- **Strict at boot.** An unknown prefix, a malformed entry, a zero, or a prefix
  named twice stops the app at start-up, and the error lists every valid
  prefix. A typo cannot silently override nothing.
- **Only points and duration.** `blockDuration` keeps its default, so the
  lockout lengths of the failure budgets cannot be changed this way.
- **Visible.** Boot logs `Rate limit overrides active` at `warn` with the
  effective values, and the panel's row shows the new ceiling.
- **Temporary.** Remove the entry after the event. If an override should
  outlive it, change the default in `src/config/rate-limits.ts` and this
  document in the same commit.

### Clearing a bucket

Redis keys are `<prefix>:<key>`, and a block is stored in the same key, so
deleting it clears both the count and the block:

The `cache` container does not carry `REDIS_PASSWORD` in its environment (it
reaches `--requirepass` through compose substitution, so it is visible to `docker inspect`; L5,
accepted, because anyone with Docker access on the host can already read `.env`), so pass it from the
host:

```sh
REDIS_PASSWORD="$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2-)"

# A locked-out admin username (already lower-cased and trimmed)
docker compose exec -e REDISCLI_AUTH="$REDIS_PASSWORD" cache \
  redis-cli DEL 'rl:admin:login-failures:<username>'

# A locked-out attendee's verification budget
docker compose exec -e REDISCLI_AUTH="$REDIS_PASSWORD" cache \
  redis-cli DEL 'rl:attendee:verification-failures:<attendee_id>'

# The global check-in failure budget, lifting the forced captcha
docker compose exec -e REDISCLI_AUTH="$REDIS_PASSWORD" cache \
  redis-cli DEL 'rl:global:checkin-entry-failures:global'
```

Prefer waiting out a short lockout. One that comes back after a manual clear
is a signal, not noise.

### Logs

| Line                           | Level   | Meaning                                                  |
| ------------------------------ | ------- | -------------------------------------------------------- |
| `Rate limiter consumed`        | `debug` | Every pass through a middleware limiter; names `limiter` |
| `Rate limiter error`           | `error` | Store failure; the request was let through               |
| `… failure budget exhausted`   | `warn`  | A failure budget refused, or raised the global captcha   |
| `Admin login budget exhausted` | `warn`  | Carries the username; also counted for the alert rule    |

Session-keyed identifiers are truncated to their last four characters in the
`debug` line.

---

## Adding or changing a limiter

1. **Add its quota to `src/config/rate-limits.ts`,** keyed by its prefix (and
   a `:trusted` entry for a tiered one). Changing a limit is only this step,
   plus step 8.
2. **Build it with `createInsuredLimiter`.** It looks the quota up from the
   prefix, registers the limiter for the panel and adds the memory tier. A
   prefix with no quota does not compile, and the `info` argument is required,
   so a limiter cannot be added without a description. `readyzLimiter` is the
   only exception, and argues why.
3. **Key on something the caller cannot rotate** (see
   [Principles](#principles)). If it keys on a session, mount it after
   `resolveSessions`.
4. **A new `keyedOn` or `protects` value** means extending `LimiterKeyBasis` or
   `LimiterPurpose` in [`src/types/limiter.ts`](../../src/types/limiter.ts) and
   adding the matching `admin-metrics.limiter.keyedOn.*` /
   `admin-metrics.limiter.protects.*` copy (see
   [`copy-management.md`](../development/copy-management.md)).
5. **Check mount order.** A specific path under `/admin` has to be registered
   above the `/admin` mount or it inherits `rl:session:admin`. A route with its
   own body limit has to be registered above `express.json`.
6. **Manually consumed budgets** must call `recordBudget`, or the panel will
   look complete while missing them.
7. **Size it against the venue,** not a single device: NAT, CGNAT, and
   whatever polling the route serves.
8. **Update this document in the same commit** — the group table, and every
   route matrix row it touches.

---

## See also

- [`security-overview.md`](../security/security-overview.md#rate-limiting-and-abuse-control): which limiters are
  cost control and which bound guessing.
- [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md): the edge layer, the Free-plan
  constraints that shaped these limiters, and how the client maps an edge
  challenge versus a 429.
- [`data-retention.md`](../security/data-retention.md): retention of the busiest-keys
  sets.
