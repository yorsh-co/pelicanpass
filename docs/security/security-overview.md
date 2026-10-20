# Security overview

The security posture of this deployment, the constraints that keep it that way, and the record of its audits.
Start here before changing a security control and before running the next audit. Every control names the file
that implements it; if this document and the code disagree, the code is right and this document is the bug.

Related:

- [`SECURITY.md`](../../SECURITY.md): reporting policy and scope
- [`data-retention.md`](./data-retention.md): what personal data is held and when it is destroyed
- [`incident-response.md`](./incident-response.md): triage, containment, evidence, notification
- [`deployment.md`](../operations/deployment.md): topology, trust boundaries, runbooks, known gaps
- [`container-containment.md`](../infrastructure/container-containment.md): keeping a compromised container off the host
- [`rate-limiting.md`](../performance/rate-limiting.md): every limiter, its key and quota
- [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md): the edge configuration, as intent

## Posture: controls by layer

### Edge (Cloudflare, Access, Caddy)

- **No inbound ports.** Traffic arrives through the Cloudflare Tunnel and the Tailscale sidecar, both outbound;
  no compose file has a `ports:` mapping.
- **WAF.** Four custom rules (non-BR block, site-wide Managed Challenge, check-in method gate, WhatsApp callback
  gate): [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md#custom-rules).
- **Access gate.** `/admin` and `/api/v1/admin` need a Cloudflare Access assertion, verified at the origin: RS256
  only, `kid` required, `iss` and `aud` checked, 403 when `CF_ACCESS_*` is unset, token and payload never logged.
  `src/middleware/access-jwt.middleware.ts`, one prefix mount in `src/app.ts`; header redacted in
  `src/shared/logger/redact-paths.ts`.
- **Tailnet listener.** `:8080` admits only the sidecar and sets `X-Admin-Gate: tailnet`; the public vhost strips
  that header on every path. **Client IP:** `:80` trusts `EDGE_SUBNET` and `CF-Connecting-IP`, `:8080` trusts the
  sidecar's `/32` and `X-Forwarded-For`; other peers get 403. `Caddyfile`.
- **`/readyz` and `/readyz/` answer 403** on the public vhost; the route also refuses without the gate header.
  `Caddyfile`, `src/app.ts`.

### Application

- **Same-origin.** A state-changing request must carry an `Origin` of ours. A missing `Origin` is refused unless
  `Sec-Fetch-Site: same-origin`; `null` passes only with that header too. The signed WhatsApp webhook is exempt.
  `src/middleware/same-origin.middleware.ts`, `src/api/index.ts`, `src/web/routes/web.routes.ts`.
- **Cross-site check-in link.** A `GET /checkin?t=` or `?k=` the browser marks `cross-site` writes no session; it
  renders a "Continue" page whose tap posts the token. `src/web/routes/checkin-entry.ts`.
- **Bodies and redirects.** JSON only (10 kB, no inflate), else 415; parser failures are 4xx, never 500; a NUL byte
  in a query or body is 400; forms are urlencoded at 1 kB; `Location` never starts with `//`.
  `src/middleware/content-type.middleware.ts`, `body-parser-error.middleware.ts`, `reject-nul.middleware.ts`,
  `src/shared/utils/url.ts`.
- **Headers and caching.** Helmet with a nonce CSP (`style-src` has no `unsafe-inline`), `Permissions-Policy` limited
  to camera and autoplay, `no-store` on every API response and admin page, `marked` notices stripped of unsafe link
  schemes. `src/app.ts`, `src/api/index.ts`, `src/web/routes/admin-page.ts`, `src/shared/utils/markdown.ts`.
- **CSV.** Importers cap input at 2 MB and 5,000 rows and refuse NUL and formula-start cells with line and column;
  exports neutralise formula-start cells. `src/modules/admin/admin.import-input.ts`, `src/constants/csv.ts`,
  `src/modules/survey/survey.csv.ts`, `scripts/db/export-results.sql`.
- **Logs.** `maskUrlSecrets` runs on every logged URL (`?preview=` included); `REDACT_PATHS` covers bodies, cookies
  and Postgres `err.detail`. `src/shared/utils/mask.ts`, `redact-paths.ts`.
- **Webhook:** HMAC over the raw body, constant-time (`src/modules/whatsapp/whatsapp.signature.ts`). No debug routes
  exist in the code.

### Rate limiting and abuse control

- **Per-IP limiters are cost control** ([`rate-limiting.md`](../performance/rate-limiting.md) has every quota), tiered for a venue behind one NAT address (`TRUSTED_IPS` via
  `net.BlockList`; a malformed entry stops boot). `src/middleware/rate.middleware.ts`, `src/config/rate-limits.ts`.
- **Guessing is bounded by budgets that do not key on IP:** failures per `attendeeId`, a global entry-failure
  budget that turns Turnstile on for everyone, per-username admin login, staff lookup.
- **Session limiters key on a digest** of the resolved session ID. `src/middleware/limiter-keys.ts`. The exempt
  paths (`/attendee/pass`, `/attendee/status`, `/survey`) are charged late if no session resolves.
  `src/api/index.ts`.
- **Degraded mode.** Every Redis limiter has an in-process twin; the client fails fast (no offline queue, 1 s `commandTimeout`); attendee surfaces answer 503 with `Retry-After`.
  `src/shared/db/redis.ts`, `src/middleware/redis-outage.middleware.ts`.
- **Admin login** runs limiter, Turnstile, then the failure counter. `src/middleware/admin-login-captcha.middleware.ts`.

### Credentials and sessions

- **Keys** are `session:<type>:<sha256(id)>`, the type re-validated on read, IDs from `crypto.randomUUID()`.
  `src/modules/session/session.service.ts`.
- **Cookies** are `httpOnly`, `secure` in production, `path: '/'`, no `maxAge`, sliding Redis TTL. Admin is
  `sameSite: strict` with a 12 h ceiling, the rest `lax`. `src/modules/session/session.adapter.ts`,
  `src/modules/admin/admin.session.adapter.ts`.
- **Binding.** A User-Agent hash per session; a new check-in revokes the attendee's previous session; the check-in
  ID rotates on verification. Permissions (`can_redeem`, `can_draw`, `redeem_scopes`, admin `is_active` and scope)
  are re-read from the database per request. `src/middleware/permission.middleware.ts`.
- **Check-in credentials.** Entry links carry an opaque `ticket_link_token`, consumed and redirected away. A
  malformed and an unknown code raise the identical error; the verification code is compared in constant time
  against the row. `src/modules/checkin/checkin.service.ts`.
- **Pass** tokens are HMAC-signed with `PASS_SECRET`, valid 60 s, spent on first verify
  (`src/modules/pass/pass.service.ts`). **Admin passwords** are scrypt, salted and peppered
  (`src/modules/admin/admin.password.ts`).

### Data and lifecycle

- **Three Postgres roles** (migrator, application, read-only). The application role has column-level
  `SELECT`/`UPDATE`, no DDL, no `COPY … FROM PROGRAM`, and cannot write the promotion columns.
  `scripts/db/init/01-roles.sh`, `migrations/`.
- **`event_id` scopes every query;** pool of 10, 5 s timeouts. `src/shared/db/postgres.ts`.
- **Nothing phone-derived is stored outside `attendees`** bar the accepted preview below. The results export has no
  name or phone and runs as the read-only role. `scripts/db/export-results.sql`. Telemetry actor IDs are hashed
  (`src/shared/telemetry/actor.ts`).
- **Lifecycle.** The host is destroyed about 24 hours after the event, so teardown is the retention policy
  ([`data-retention.md`](./data-retention.md#teardown--the-one-procedure-that-matters)). Purges are hand-run SQL;
  the results export is pseudonymous, not anonymous, and any `pg_dump` kept is the failure mode.

### Containers and host

- **Every service** in `compose.prod.yml` is `read_only`, `cap_drop: ALL`, `no-new-privileges`, with memory and pid
  limits (`app`: 1 GB, 128) and rotated logs. `scripts/compose/hardening.test.ts`.
- **Networks.** `edge`, `web` and `data` are `internal`; `app` has its own gateway network, `app-egress`, shared
  with no connector. `scripts/compose/network-egress.test.ts`.
- **Environment is scoped per service;** `app` holds no superuser, migrator, tunnel or Tailscale secret.
  `scripts/compose/env-scope.test.ts`. **Images** are pinned `tag@sha256` everywhere.
  `scripts/compose/image-pins.test.ts`.
- **Build context** is a `.dockerignore` allow-list (`npm run check:docker-context`); the `prod` and `fallback`
  images omit tests and client sources; the code is root-owned. `Dockerfile`.
- **Egress filter** drops RFC 1918, link-local and CGNAT on the uplink, plus `INPUT` drops for bridge gateways.
  `scripts/container-egress-filter.sh`. **Standby snapshots** are size-capped and member-checked before extraction.
  `scripts/standby/lib.sh`.

## Load-bearing by design

Things that read like oversights. Do not "improve" them without reading the reason.

- **Identical errors** for a malformed and an unknown ticket or link token (`validateTicket`,
  `validateTicketLink`). Friendlier messages create an enumeration oracle.
- **Poster token.** `validateQrToken` compares with plain `!==` and `validateStep` exempts `source === 'qr'`: the
  token is printed on a wall, and poster entry has nothing to verify first.
- **Inline JSON** blocks escape `<` to `\u003c` and carry the nonce. Size bounds (10 kB JSON, 1 kB forms, 2,048
  characters for a Turnstile token) are why there is no schema library.
- **Helmet defaults.** `frame-ancestors 'self'` is the clickjacking control. `Referrer-Policy: no-referrer` keeps
  `?t=` out of `Referer` and makes same-origin form posts send `Origin: null`, which `requireSameOrigin` admits
  only with `Sec-Fetch-Site: same-origin`. Change one, re-read both.
- **No cookie `maxAge`:** it is absolute while the session slides, and would drop a slow check-in's cookie. `lax`
  for non-admin sessions because the entry link arrives from off-site.
- **`IP_LIMIT_EXEMPT` is an exact-path set,** charged after `resolveSessions`; a mount would double-charge
  sub-paths. The exemption is earned by the session, not the path.
- **Mount order in `src/api/index.ts`.** `/admin/auth`, `/admin/metrics`, `/admin/whatsapp/runs/current` and
  `/admin/redemptions/summary` sit above `/admin` to escape `adminSessionLimiter`, each with its own session and
  scope check. The Access gate stays one prefix mount above every router.
- **Caddy.** `{client_ip}` resolves, `{http.request.client_ip}` does not. `trusted_proxies` must never widen to
  `172.16.0.0/12`, which covers `web`. `X-Admin-Gate` is stripped on every public path, not only admin ones.
- **Network shape.** `app` shares no network with `tunnel` or `vpn`, or a connector could forge `X-Admin-Gate`;
  `edge`, `web` and `data` stay `internal`.
- **Grants are role-wide, with no table-level default for the application role:** a new table is unreadable until
  its migration grants it, and the role cannot promote itself. **Purges are hand-run SQL,** not migrations:
  `migrate up` runs everything pending, mid-event.
- **`/readyz`** is above the limiters, tailnet-only, and wired to no `HEALTHCHECK` or restart: a Redis blip must not
  restart the container. **The landing curtain is not a control:** `checkinWindowGate` and `checkin.service.ts`
  refuse an early check-in.
- **Dev workflow.** `compose.yml` keeps `target: dev`, `user: root` (rootless EACCES) and the bind mount; hardening
  lives only in `compose.prod.yml`, never layered. After a build, compose or Docker change, confirm hot reload with
  `docker compose logs -f app`.
- **F-A1-7:** the fallback answers `/admin*` with the curtain; `src/fallback/` has no admin handler and ignores
  `X-Admin-Gate`. **N-A3-3:** a missing `Content-Type` passes the 415 gate; a body-less request has no type.
- **L8:** `attendees:import`, `raffle:read`, `raffle:write` and `admins:write` are grantable and guard no route
  ([`admin-scopes.md`](../features/admin-scopes.md#reserved)). Wiring one needs an authorisation review first.
- **N-A3-8:** sessions bound to a User-Agent hash. Keep it; it is no secret and counts as no factor.

## Accepted risks

### The code keyspaces and the poster token

`SECURITY.md` puts the participant ticket-code and verification-code keyspaces and the static QR poster token out
of scope. They are structural to the event design:

- Participant ticket codes (a source key plus five characters) come from an external sign-up system. The
  verification code is the last four digits of the attendee's phone: 10,000 values. This repo cannot widen either.
- At an in-person event one IP is the whole room, so no per-IP limit can stop guessing. What does is not IP-keyed:
  10 wrong codes per attendee per 15 minutes (about 40 guesses an hour), a global entry-failure budget with captcha
  escalation, identical errors and constant-time comparison.
- The poster token attests presence in the room. It is on a wall, so rotation, time-boxing or a per-IP limit would
  add deployment hazard and throttle the room for no gain. In scope, because this repo controls them: volunteer codes (key `v` plus five characters generated from a
  27-character alphabet, about 14.3 million) and the per-attendee pass credential.

### Others

| Risk                                                                       | Reason                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass relay (2026-08-21)                                                    | A screenshot relayed live in seconds is not stopped; it burns the sender's entitlement. The ticket code on the pass is half the check-in credential, the phone digits the other; the pass exists only after check-in and `completeCheckin` is idempotent.                                |
| `attendeePreview.phoneStart`; verification code on the admin record page   | Five leading digits, TTL-bound; the code sits behind `attendees:read` in a closed `details`. [`data-retention.md`](./data-retention.md#the-one-exposure-that-is-accepted).                                                                                                               |
| F-A4-2, N-A34-3: writable, executable data volumes (`logs`, `cache`, `db`) | Docker cannot mount a persistent named volume `noexec` on rootless. The attacker needs code as an unprivileged user with no capabilities on a read-only root; `cache` and `db` have no route out. [Containment §3.2](../infrastructure/container-containment.md#32-container-hardening). |
| L5: Redis password in `docker inspect` and argv                            | A Compose secret forces a writable root on `cache`; whoever has Docker access can read `.env` anyway.                                                                                                                                                                                    |
| F-A1-3: admin captcha enforcement off                                      | Refusing to boot would remove the Turnstile-outage rescue, so production logs a startup warning (`src/config/startup-notices.ts`). With it off, anyone holding an Access assertion can lock a named administrator out.                                                                   |
| L6: `k6` on `web` in `compose.loadtest.yml`                                | It reaches `app:3000` without Caddy and can set `X-Admin-Gate`. A test stack with seeded data and no production secrets; never run it with real `CF_ACCESS_*` or admin credentials.                                                                                                      |
| Bare 403 from the Access gate has no `Cache-Control`                       | The body is `Forbidden`; covering it needs `noStore` ahead of the gate.                                                                                                                                                                                                                  |
| Admin and check-in cookies share an origin                                 | Cookie-type confusion returns 401, the type being bound server-side. [Recorded](../infrastructure/cloudflare-rules.md#accepted-consequences).                                                                                                                                            |

## Decisions in force

| Decision                                                                                                                                                                                                               | Date       | Why                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator CLIs run on `migrate`, except `scripts/qr`, `scripts/telemetry`, `scripts/whatsapp` on `app`                                                                                                                  | 2026-10-07 | Keeps migrator and read-only credentials out of `app`.                                                                                                                       |
| Cross-site check-in arrivals see a "Continue" page                                                                                                                                                                     | 2026-10-07 | A `GET` that writes a session can plant an attacker's ticket.                                                                                                                |
| Missing `Origin` refused unless `Sec-Fetch-Site: same-origin`                                                                                                                                                          | 2026-10-07 | Closes Chrome's two-minute Lax+POST window; scripted clients (curl, k6) send `Origin`.                                                                                       |
| Admin captcha enforcement off warns, does not stop boot                                                                                                                                                                | 2026-10-07 | Keeps the Turnstile-outage rescue.                                                                                                                                           |
| Formula-start cells in imports refuse the row, with line and column                                                                                                                                                    | 2026-10-07 | Spreadsheets execute them; these fields never legitimately start so.                                                                                                         |
| `cache` keeps a read-only root; the Redis password stays in argv                                                                                                                                                       | 2026-10-07 | See L5.                                                                                                                                                                      |
| `app`: `mem_limit: 1g`, `pids_limit: 128`                                                                                                                                                                              | 2026-10-19 | About 2x peak (401 MiB, 15 PIDs), session `2026-10-19T2007Z-prod-server-04fb5a3`; 128 as each `exec` CLI adds about 11 threads. Re-run `2026-10-19T2055Z-prod-server-36d9653`: no OOM. |
| Tooling images (tests, `k6`) pinned to the same digests                                                                                                                                                                | 2026-10-07 | One pin set; `image-pins.test.ts` fails on drift.                                                                                                                            |
| No rotation, time-boxing or per-IP limit on the poster token                                                                                                                                                           | 2026-08    | See above; the plain `!==` is deliberate.                                                                                                                                    |
| Per-attendee pass credential, signed with `PASS_SECRET`                                                                                                                                                                | 2026-08-21 | A screenshot equals the live page, which the poster token never faced.                                                                                                       |
| Phone digests deleted, not keyed with an HMAC                                                                                                                                                                          | 2026-08    | Nothing to attack in a Redis dump, no secret to manage.                                                                                                                      |
| Admin cookie `sameSite: strict`                                                                                                                                                                                        | 2026-08-24 | Nothing links into `/admin`; closes the Lax+POST window.                                                                                                                     |
| Request logs keep `ip`, `xff`, `cfIp`, `country`, `userAgent`; the privacy notice declares them                                                                                                                        | 2026-08-26 | `cfIp` is the only independent check on `req.ip`.                                                                                                                            |
| `:8080` keys limiters per operator, from the sidecar's `X-Forwarded-For`                                                                                                                                               | 2026-08-28 | Otherwise every operator shares one budget.                                                                                                                                  |
| Declined: RLS, hashing names or phones at rest, a schema library, a DB role per concern, a signed session cookie, a blanket Managed Challenge on web routes, fingerprint obscurity, short-circuiting `resolveSessions` | 2026-08    | Column grants, least privilege and teardown cover them; the challenge breaks in-app webviews. Reopen only with a new reason.                                                 |

## Open items

- **Cloudflare `/checkin` rate-limiting rule** (600/60 s, Managed Challenge, plain IP). Deferred: the October event
  produced no measured threshold. Size it from the next event's dry run, never before.
  [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md#rate-limiting-rule--not-yet-created).
- **`ejs` 7.0.2** is not taken (7.0.1 is installed; 7.0.2 carries no security fix). Take it with the next
  dependency pass, behind `src/web/views/render-snapshots.test.ts`.
- **Production conformance pass** before the next event, with its results written down: October's were confirmed
  by the operator and not kept. The checklist below.
- **Known gaps.** The table in [`deployment.md`](../operations/deployment.md#known-gaps-at-this-revision) still
  lists the UFW baseline, hand-set permissions, admin limiter and TTL sizing, the actor of hand-marked presence and
  host disk encryption. The August "also outstanding" items it lacks (WAF cross-check, dry run with Challenge Solve
  Rate, the fallback for a stranded attendee) are checklist items 21, 24 and 25.

## Before every event: security checks

One list, numbered so other documents can cite an item. Run it on the production host, reads only: no writes, no
data reads, no load, no credential guessing. Record dated results.

1. A check-in session ID copied into `admin_session_id` answers 401; the reverse too.
2. From inside `app`, not through Cloudflare, `/admin`, `/admin/login` and `/api/v1/admin/anything` answer 403
   without an assertion or `X-Admin-Gate`, and the log has no `error` line.
3. Through the public hostname, `/admin` and `/api/v1/admin/me` with no Access token reach the Access login or a
   403, never the app; the same with `X-Admin-Gate: tailnet`.
4. `https://<host>/readyz` and `/readyz/` answer 403.
5. `curl -sI 'https://<host>//evil.example//x?lang=pt-BR'` has no `Location`, or one starting with a single `/`.
6. `curl -sI https://<host>/checkin`: security headers match the local production build. TLS 1.1 fails; 1.2 and
   1.3 succeed. A request from outside the geo gate is refused by the edge, when one is available.

7. `LANDING_BYPASS_TOKEN` is unset: `docker compose -f compose.prod.yml exec app printenv LANDING_BYPASS_TOKEN`
   prints nothing or an empty line.
8. The `app` boot log has no `TURNSTILE_ADMIN_ENFORCE is false` warning.
9. `CHECKIN_SESSION_TTL` is at most 900 and `ATTENDEE_SESSION_TTL` is 86400, as the privacy notice says.
10. The live `CHECKIN_QR_TOKEN` differs from the fixture in `src/config/env.test.ts`.
11. `docker inspect` of `app` names no `POSTGRES_SUPERUSER*`, `POSTGRES_MIGRATOR*`, `POSTGRES_READONLY*`,
    `TUNNEL_TOKEN` or `TS_AUTHKEY` key.

12. `docker compose exec app id` is `node`, with no bind mount; deployed digests match the `tag@sha256` pins.
13. `docker run --rm --entrypoint ls <prod image> -la /usr/src/app` lists only `RELEASE`, `node_modules`,
    `package*.json`, `scripts` and `src`.
14. A throwaway container on `edge` alone cannot resolve `db`, `cache` or `app`.
15. [`container-containment.md` §9](../infrastructure/container-containment.md#9-new-machine-checklist) on the
    production host, ending with a reboot and the §6 checks again; `status` shows the two `INPUT` drops and check 7
    times out on every network.
16. Standby, if used: the `authorized_keys` line has `from=`, `command=` and `restrict`; other commands are refused;
    `~/standby` is mode 600 on both hosts.
17. With `WHATSAPP_WEBHOOK_ENABLED=true`, one Meta test delivery logs `WhatsApp receipts applied`.

18. Access covers `/admin`, `/admin/*`, `/api/v1/admin` and `/api/v1/admin/*` on every tunnelled hostname; its
    `aud` equals `CF_ACCESS_AUD` and differs from other team applications'. Record the identities and session
    length. Record the tailnet ACL and who can reach the `vpn` node.
19. Every tunnel hostname targets `http://proxy:80`, none `app:3000` or `:8080`.
20. Each Turnstile widget lists only the host that serves it (no caller passes `expectedHostname`; the widget
    allowlist is the control). Minimum TLS version and HSTS are recorded; no Transform Rule strips a header.
21. The four WAF custom rules match [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) in expression and
    order.

22. Zero CSP violations in the browser console on `/checkin`, `/pass`, `/staff`, `/raffle` and every admin page;
    the pass QR renders from its `data:` URI and no icon shows as ligature text.
23. A pass backgrounded for two minutes, or screen-locked, refreshes on return rather than showing a stale band.
24. Dry run: a printed QR, a real phone, the WhatsApp in-app browser, end to end; watch Challenge Solve Rate.
25. A manual fallback is ready at the door for anyone a challenge strands.
26. Two phones: volunteer B scans A, hands over an item, A's pass reads `retirado`, a second scan reads
    `duplicate`. [`deployment.md`](../operations/deployment.md#15--two-phones-end-to-end).

## Next audit

**Method.** Two stages, in order. **Stage A, the origin holding alone:** assume Cloudflare did nothing (no WAF, no
geo gate, Access missing); anything safe only because the edge blocks it is a finding. **Stage B, the edge:** review
our Cloudflare configuration as a second layer that shrinks what reaches the origin and is never the only control.

- Throwaway stacks from a detached worktree at the baseline, under their own compose project names (`-p audit-dev`,
  `-p audit-prod`; `compose.prod.yml` fixes `container_name`, so add an uncommitted override). Never touch the
  running stacks or read the real `.env`; copy `.env.example`. Production gets only the operator's read-only
  conformance pass.
- Evidence in `.ignore/audit-<yyyy-mm>/` (gitignored): command, raw output, a one-line verdict; delete it at close,
  as it holds throwaway keys. Reproduce every finding on a running stack or record it as plausible. Fix nothing
  mid-audit.
- After triage, one `fix/*` branch per finding, a failing test committed first, a CHANGELOG entry, the reproduction
  re-run on a fresh stack, then the whole set re-run on `develop`.
- **Regenerate the route matrix** from `src/app.ts`, `src/api/index.ts`, `src/web/routes/*.ts` and every
  `*.routes.ts`: one row per method and path with vhost, gates, limiters and `IP_LIMIT_EXEMPT`. October's is in the
  tag below and predates later changes; use it only to diff for new routes.

**Finding format,** numbered from F1, ranked by severity:

```md
### F<n> (<severity>): <one-line claim>

- **Reproduction:** commands, against which stack, at which commit.
- **Impact:** who can do what, and to which data.
- **Evidence:** `.ignore/audit-<yyyy-mm>/<step>/<file>`.
- **Fix:** proposed `fix/<slug>` branch and the test that will reproduce it.
```

**Severity.** _High_: reach to another user's data or admin capability from the internet. _Medium_: needs a
precondition, or affects the availability of the event. _Low_: defence in depth. _Notice_: documentation or
informational.

**Regression checks worth re-running**

- Checklist items 1 to 5 (cookie-type confusion, the origin's own 403, `/readyz/`, the redirect).
- Access assertion: expired, wrong `aud`, wrong `iss`, `alg: none`, HS256 signed with the public key, missing or
  unknown `kid`, JWKS unreachable, `CF_ACCESS_*` unset: all 403, none logged with the token.
- `X-Admin-Gate` forged through `:80` (casings, twice, comma-joined) is refused; only `proxy` reaches `app:3000`
  from any network `app` shares. Path variants (`/ADMIN`, `//admin`, `/%61dmin`, `/admin%2Fme`) hit the gate or 404.
- Missing `Origin`, `Origin: null`, a lookalike host and a scheme change are refused on every session type; a
  cross-site `GET /checkin?t=` writes no session.
- `text/plain` and multipart: 415. 10 kB + 1: 413. `{not json`: 400. A NUL in JSON, query or survey answer: 400.
  In production mode (development masks it), `no-store` on 401, 403, 429 and 404 API responses.
- Logs for a request with `Cookie`, `Cf-Access-Jwt-Assertion`, `?preview=` and a forced unique violation hold none
  of those values; no Redis key, panel row or `app_events.actor_id` holds a raw session ID, cookie or username.
- 310 anonymous requests to `/attendee/pass`: 429 after 300. 11 bad verification codes for one attendee across
  cookie jars are blocked. Redis stopped: 503 in about 0.1 s, limits still bite, `RestartCount` stays 0.
- Revoking `can_redeem`, `can_draw` or an admin scope bites on the next request; an attendee cannot read or change
  another's pass, nickname or survey, nor replay another session's `Idempotency-Key`.
- As the application role, `COPY … TO PROGRAM` and `UPDATE` of `can_redeem` or `ticket_code` fail. Every `${…}` in
  repository SQL is a module constant; `LIKE` input is escaped.
- Imports refuse formula-start cells, NUL and oversized files; exports neutralise formulas. Every `<%-` prints
  trusted content; notices drop `javascript:` links; a Chromium sweep shows 0 CSP violations.
- `docker inspect` per service: user, read-only root, `CapDrop`, `no-new-privileges`, limits, scoped env. From
  `app`, the host, RFC 1918, `169.254.169.254`, tailnet addresses and the bridge gateway are unreachable.
- `gitleaks` over full history is clean; `npm audit --omit=dev` reports 0; a standby stream over the cap, or a tar
  member that is a symlink or unlisted, is refused; a signed webhook is 200 and an altered one is refused.

## Audit history

| Audit          | Scope                                                                                  | Findings                                                                              | Outcome                                                                      | Full record                                                                          |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| August 2026    | Server, sessions, DB, routes, views, compose and proxy                                 | 15: 1 Critical, 4 High, 9 Medium, 1 Low                                               | 14 closed; #2 partial (code done, reprint physical); edge rate rule deferred | `git show archive/security-audits-2026:docs/security/security-remediation-report.md` |
| September 2026 | Every route's session gate and limits, Helmet, privacy notice                          | 7: 1 High, 2 Medium, 1 Low-Medium, 2 Low, 1 Notice (1 more dropped, not reproducible) | All closed 2026-09-26; one accepted gap                                      | `git show archive/security-audits-2026:docs/security/route-security-audit.md`        |
| October 2026   | Stage A origin (routes, request to database, attack surface, containers), Stage B edge | 17: 0 High, 3 Medium, 14 Low, plus Notices                                            | 16 closed (F-A1-3 mitigated), 1 accepted (F-A4-2); `/checkin` rule deferred  | `git show archive/security-audits-2026:docs/security/security-audit-2026-10.md`      |

The audit records are kept in the private archive repository under the annotated tag
`archive/security-audits-2026`; the `git show` commands above run there, not in this repository.

Lessons that shape future work:

- Acceptance is a measurement on a running stack, not reasoning: UFW did not cover containers, a Caddy placeholder
  passed through as literal text, and Redis-down latency was over 60 s, not 10.
- A check that silently does nothing reads as an assurance: three of six containment checks tested nothing real.
  Prove persistence by destroying (flush the chain, restart the daemon).
- Size limits against the venue, not the person: one NAT address is the whole room.
- Deleting a secret beats keying it: the phone digests were removed, not HMAC-ed.
- A fix can open the next finding (the `Origin` fix broke signed webhooks; the egress change put a connector on
  `app`'s network). Re-run every reproduction after the last merge.
