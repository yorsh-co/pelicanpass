# Cloudflare configuration

Edge configuration for the public hostname, written `<host>` below: `SITE_HOST` in `.env`, which
reaches this app through `cloudflared` → Caddy → the `app` container.

**This file is the intent: what should be configured, and why each choice is the one it is.** If the
dashboard differs, the dashboard is what is running and one of the two is wrong — but this is the
document to rebuild from, after an account change or a year later, so every object below carries its
expression, its action, and what breaks if the action is wrong.

`cloudflared` means every request is proxied, so WAF custom rules and rate limiting rules both apply.
The account is on the **Free** plan, and that is what dictates the shape below. Companion to
[`security-overview.md`](../security/security-overview.md), which records the posture these rules support.

---

## What the Free plan actually allows

Read from the dashboard rather than from documentation, because the constraint that matters is not
the one the audit assumed.

**Rate limiting rule — the counter keys on `ip` and nothing else.** _IP with NAT support_ is not in
the characteristics selector on this plan. That single fact retires the audit's central
recommendation for this deployment: a ~10 req/min rule on `/api/v1/checkin/*` was only safe at a
NAT'd venue because that characteristic distinguishes visitors sharing one address. Keyed on plain
IP, the same rule challenges the entire room.

**Rate limiting rule — matches on `URI Path` alone.** No Country, no Request Method, no IP. So the
one rule cannot be narrowed away from the venue's own traffic by any means.

**Custom rules carry the useful fields.** This is why the phase's value moves off the rate limiting
rule entirely — `Country` and `Request Method` exist only here.

**There are five custom rules and ten configuration rules.** That ratio decides which object gets
used for what below: an exemption goes in the plentiful bucket, and the scarce one is spent only on
a rule that refuses something.

**Bot Fight Mode cannot be skipped.** It is a Free-plan feature that sits outside the Ruleset
Engine, so no custom rule and no configuration rule can exempt a path from it — Cloudflare's skip
documentation is explicit that only *Super* Bot Fight Mode, a paid tier, can be skipped. **This is
the one control on this zone that cannot be steered per-path.** It has its own section below; it
is on, and it has been verified not to block Meta's webhook deliveries.

### Rate Limit Rule Field Options

#### RAW FIELDS

- URI Path

#### BOT TRAFFIC

- Verified Bot
- Verified Bot Category

#### WEB APPLICATION EXPLOITS

- Password Leaked

#### WEB ASSETS

- Operation ID

### Custom Rule Field Options

#### Request

- AS Num
- Cookie
- Country
- Continent
- Hostname
- IP Source Address
- Referer
- Request Method
- SSL/HTTPS
- HTTP Version
- User Agent
- X-Forwarded-For
- Client Certificate Verified
- MIME Type
- Header
- Cookie value of

#### Raw Fields

- URI Full
- URI
- URI Path
- URI Query String

#### API ABUSE

- Fallthrough detected
- Uploaded schema violated

#### BOT TRAFFIC

- Known Bots
- Verified Bot Category

#### WEB APPLICATION EXPLOITS

- Disposable email check
- Password Leaked

#### WEB ASSETS

- Operation ID

---

## Bot Fight Mode

**State: on. Read from Security → Bots on 2026-09-11, 2026-09-22 and 2026-09-23 — unchanged.** It
conditions every other object in this file, so the facts below are recorded rather than re-derived.

**It is not the DDoS protection.** Cloudflare's DDoS defence is the L3/4 and L7 DDoS managed
rulesets: always on, every plan, not disableable, and unrelated to this feature. Turning Bot Fight
Mode off costs nothing in DDoS terms.

**It cannot be exempted per path.** It runs outside the Ruleset Engine, so skip actions, custom
rules, configuration rules and Page Rules all have no effect on it. Cloudflare's documented caveat is
that it "may challenge legitimate API or mobile app traffic".

**It does not block Meta's webhook deliveries.** Verified on 2026-09-23: with it on, the `GET`
handshake saved and real delivery receipts reached the origin and were applied. This was the one open
question it posed, and it is closed.

**If that ever changes**, receipts stop with nothing in the origin's logs, and Security → Events shows
entries whose service is *Bot Fight Mode* on the callback path. The remedies, cheapest first:

- turn it off for the send window, and keep it off until the last run's receipts have stopped
  mattering — flipping it back mid-window kills receipts for every message still in flight;
- Pro (~US$20/month), whose *Super* Bot Fight Mode runs on the Ruleset Engine and accepts a skip rule;
- a second zone for the callback hostname, since the setting is per zone. It needs a second apex
  domain; subdomain zones are Enterprise-only.

A `workers.dev` front door was considered and rejected: it cannot reach the origin without re-entering
the zone, and the version that works parks receipts — which carry a phone number as `recipient_id` —
in Cloudflare KV, outside the retention story in [`data-retention.md`](../security/data-retention.md).

---

## Zone settings

Four settings outside the Ruleset Engine, each with the consequence that makes it load-bearing. Read
from Security → Settings and Security → Bots; last confirmed 2026-09-22.

| Setting                 | Required value                                     | Why it matters here |
| ----------------------- | -------------------------------------------------- | ------------------- |
| Bot Fight Mode          | **On**                                             | Cannot be exempted per path on this plan — see above |
| Challenge Passage       | **16 hours**                                       | The lifetime of every `cf_clearance`, and so of the client's whole challenge-recovery story |
| Security Level          | Not exposed; only *I'm Under Attack*, which is **off** | Nothing at zone level challenges a visitor on reputation alone |
| Browser Integrity Check | **On**                                             | Acts without a rule and keys on request headers |

**Challenge Passage is the cheapest lever this zone has.** At 16 hours a visitor solves the site-wide
challenge once and keeps the clearance for longer than an event lasts. Anything that drops it for a
test must put it back to 16 hours, not to Cloudflare's 30-minute default.

**Browser Integrity Check is why a bare `curl` is not evidence about the origin.** It filters on
headers rather than reputation, so it can refuse a non-browser caller at the edge and hand back a 403
that never reached the application. When a check needs to prove the origin refused something, the
origin's log line — or `via: 1.1 Caddy` and `content-length: 9` on the response — is the assertion, not
the status code. It does not refuse Meta's webhook deliveries: the configuration rule that once turned
it off on the callback path was deleted, and receipts arrive without it.

---

## Custom rules

**Five slots on this plan. Four are used and one is spare.**

Rules are listed in the order they should be evaluated. Match and delete by **expression**, never by
position: the dashboard numbers them by its own order, this file numbers them by argument, and the
two have disagreed before.

**Rules 1 and 2 both exclude the WhatsApp callback prefix, and no rule may be widened to cover it.**
Meta delivers from the US and no server can solve a challenge, so a block or a challenge on that path
makes Meta count every delivery as failed and retry for up to seven days until the receipts are
simply gone — with nothing in our logs, because nothing ever reached the origin. The exclusion is the
whole exemption; there is no configuration rule behind it.

### 1. Non-Brazilian traffic — Block

```
ip.src.country ne "BR"
and not starts_with(http.request.uri.path, "/api/v1/whatsapp/webhook/")
```

**Action: Block.** Every attendee, volunteer and administrator is in Brazil for an event held in
Brazil, so nothing legitimate is lost at home, and every remote scanner and credential-stuffer is cut
off before rule 2 spends a challenge on it.

It is a Block rather than a Managed Challenge, which goes against the preference stated in _Two facts
that shape every action choice_ below. The consequences are accepted, not overlooked:

- **A Brazilian abroad, or on a foreign-routed address, is refused outright.** A Block carries no
  `cf-mitigated` header, so `modules/ui/challenge-gate.ts` raises nothing and the attendee sees the
  `UNKNOWN_ERROR` copy with no way forward. The same holds for an administrator: Cloudflare Access is
  never reached. The recovery is the tailnet path on `ADMIN_URL`, which bypasses Cloudflare.
- **The external uptime monitor must probe from Brazil.** `/healthz` is not excluded here, and the
  monitor in use does probe from Brazil. See [`deployment.md`](../operations/deployment.md) § _The dead-man's
  switch_.
- **Country is Cloudflare's geolocation**, not the attendee's. A Brazilian mobile carrier that routes
  through a foreign exit would be refused. None has been observed.

### 2. Site-wide Managed Challenge

```
http.request.uri.path ne "/healthz"
and not starts_with(http.request.uri.path, "/api/v1/whatsapp/webhook/")
```

**Action: Managed Challenge.** Every visitor solves it on their first navigation and holds a
`cf_clearance` for the 16 hours above. This is the rule that does the most work on this zone, and three
other things depend on it:

- It is what makes the check-in API safe against a Brazilian caller with a script. A caller with no
  clearance is challenged, and a Managed Challenge cannot be solved from a script.
- It is what mints the clearance whose expiry the client recovers from
  (`modules/ui/challenge-gate.ts`), and it sets `cf-mitigated: challenge`, the header that recovery
  keys on.
- It is the rule to disable if the challenge has to come off mid-event. Nothing else at zone level
  challenges a visitor, so with this off the administrator sign-in stands on Access and Turnstile
  alone — which is what the Turnstile work exists for, and which has been rehearsed.

**It covers every hostname on the zone.** An earlier revision scoped it with
`http.request.full_uri contains "<deployment hostname>"`. The current expression has no hostname condition, so any
other hostname on this zone is challenged too.

**It applies to `GET /checkin` too**, the scanned-QR entry path opened from a WhatsApp webview, where
interstitials are least reliable. That is accepted deliberately: one solve per 16 hours, against the
cost of maintaining an exemption. If a dry run shows attendees stumbling on it, the fix is a condition
on this rule rather than a new one.

**`/healthz` is excluded** because the external uptime monitor in
[`deployment.md`](../operations/deployment.md) § _The dead-man's switch_ cannot solve a Managed Challenge, and
without the condition it reports the site down permanently. The path answers `{"status":"ok"}` without
touching Postgres or Redis, so exposing it to scripts discloses nothing beyond reachability. The
match is exact (`ne`), so `/healthz/…` and `/readyz` stay challenged.

**The callback prefix is excluded** for the reason stated above the rules. It replaced a
configuration rule (Security Level _Essentially Off_, Browser Integrity Check _Off_), which has
been deleted: Security Level governs reputation-based challenges, not a custom rule's action.

### 3. Method gate on the check-in API — Block

```
starts_with(http.request.uri.path, "/api/v1/checkin/") and http.request.method ne "POST"
```

All four check-in routes are POST-only (`src/modules/checkin/checkin.routes.ts`).

### 4. WhatsApp receipt callback — Block

```
starts_with(http.request.uri.path, "/api/v1/whatsapp/webhook/")
and not (http.request.method in {"POST" "GET"} and ip.geoip.asnum eq 32934)
```

**Verified on 2026-09-23:** Meta's `GET` handshake saved the subscription and its receipts were
applied, both through this rule.

The callback is the first genuinely public inbound **write** this application holds. Its real
boundary is an HMAC over the raw body (`X-Hub-Signature-256`, keyed on the Meta app secret), which
lives in the origin. This rule is what keeps a forged-signature flood from reaching that check at
all, and it earns its slot because the one rate limiting rule is **reserved** for `/checkin` (§ _Rate
limiting rule_) and cannot also cover this path. Per-request throttling for the callback therefore
lives in the application — `rl:ip:whatsapp-webhook` and `rl:global:whatsapp-webhook` in
`src/middleware/rate.middleware.ts`; see [`rate-limiting.md`](../performance/rate-limiting.md).

**Block rather than Managed Challenge.** Nothing an attendee can reach touches this path; the only
caller is one of Meta's servers, to which a challenge and a block are the same dead end. The block is
the cheaper of the two and the clearer Security Events entry.

**AS32934 is Meta's ASN.** Pinning to it is the strongest edge control available on this plan, and
also the most brittle:

- If Meta ever delivers from another ASN, **receipts stop and nothing local says why.** Security →
  Events will show this rule blocking requests from Meta's servers on the callback path.
- Deleting this rule is one dashboard edit, and deleting it degrades to the method-only form
  (`not http.request.method in {"POST" "GET"}`) rather than to nothing.
- Re-saving the callback in Meta's dashboard is a live test of the ASN clause: **if the ASN is wrong,
  the subscription will not save.**
- A later drift is caught by the application's alert for a completed run with no receipts, which is
  the case the handshake cannot cover.

Meta's own documented alternative is an IP-prefix allow-list; see _Deliberately not used_.

---

## Rate limiting rule — NOT YET CREATED

**This is the outstanding item. It needs creating and testing before the event.** Re-read from
Security → Security rules → Rate limiting rules on 2026-09-22: still absent.

**2026-10-19:** the rule was not created before the 2026-10-17 event, and the event did not produce a
measured threshold: the request log was lost in the post-event recreate
([event report](../reports/event-2026-10-17.md#what-the-data-cannot-show)). It stays deferred to
the next event, to be sized from that event's dry run.

| Field          | Value                  |
| -------------- | ---------------------- |
| Path           | `/checkin`             |
| Rate           | **600 requests / 60s** |
| Characteristic | IP (the only option)   |
| Action         | Managed Challenge      |

`/checkin` is GET-only, so matching on `URI Path` alone is precise enough. A Managed Challenge is
genuinely solvable here because it is a **navigation** rather than a `fetch`.

600, not the audit's ~10, and not a number pulled from the air: it sits at the ceiling of the app's
own relaxed tier for this route (`checkinEntryIpLimiter`, 600/min trusted), so the edge never
becomes the binding limiter on the venue address. This is a denial-of-service ceiling, not a
brute-force control — the brute-force control is the global failure budget in
`src/middleware/rate.middleware.ts`, which does not key on IP and so is unaffected by NAT. Every
application limiter is catalogued in [`rate-limiting.md`](../performance/rate-limiting.md).

**Set it after the dry run, not before.** The dry run produces the venue's real page-load rate;
picking a threshold ahead of that is how the venue gets challenged.

**And it stays on `/checkin`.** The WhatsApp receipt callback is the other candidate for the single
rule this plan gets, and it does not win: `/checkin` protects the attendees' own entry path, while
the callback has an HMAC in front of it and an application-side limiter pair behind its own rule.
Written
down because "we have one rule and two things that want it" is a decision, not an oversight.

### Why the rate limiting rule is not on `/api/v1/checkin/*`

The audit recommends exactly that, and on any plan with _IP with NAT support_ it would be right.
Here it cannot work:

- It matches on `URI Path` alone, so it counts venue traffic with no way to exclude it.
- It keys on plain IP, so the whole room is one counter.
- Any threshold below the venue peak (~400 req/min at 40 arrivals/min) challenges every attendee.
- Any threshold above it sits above the app's own strict tier (300/min) and therefore never fires.

There is no value left in between. The one rule is better spent as a DoS ceiling on `/checkin`.

---

## Cloudflare Access — the administrator surface

`/admin` and `/api/v1/admin` answer on the public hostname, behind an Access policy at the edge **and**
the origin's own verification of the assertion. The tailnet path on `ADMIN_URL` stays beside it as the
fallback if the edge misbehaves.

### The application

One **self-hosted** application, with **two destinations**:

```
<host>/admin
<host>/api/v1/admin
```

- Policy **Allow**, selector **Emails**, every address listed explicitly. **Not _Emails ending in_** —
  the volunteers are on consumer mail domains, and a domain rule would admit every account at that
  provider.
- Identity provider **One-time PIN**. No IdP to configure and no account for a volunteer to create.
- Session duration **24 hours**, comfortably longer than an event.
- Record the **Application Audience (AUD) tag**. The origin needs it as `CF_ACCESS_AUD`, alongside the
  team hostname as `CF_ACCESS_TEAM_DOMAIN`.
- Zero Trust Free covers 50 seats.

**One application with two destinations, not two applications.** `CF_Authorization` is bound to an
application's audience, so with two, a volunteer who had just authenticated for the pages would meet a
second authorisation on their first XHR — a 302 to the team domain that `fetch` reports as a network
failure — at the start of the night rather than after 24 hours. One application also means one AUD for
the origin to check.

An unlisted address is refused **silently**: Cloudflare shows the same code-entry screen and sends no
PIN, so the form does not leak who is authorised. The operational symptom is "the code never arrived".

### The origin verifies the assertion itself

`src/middleware/access-jwt.middleware.ts` checks `Cf-Access-Jwt-Assertion` against the team's JWKS, the
configured `aud` and the team domain as `iss`. This is not belt-and-braces; it is the point.

Access binds its policy to a hostname and a path **at the edge**, and nothing about that arrangement is
visible from the origin. A second public hostname on the tunnel, or a mistyped path in the application
definition, would open the whole surface with nothing in this deployment to notice. Verifying the
assertion here inverts that: the edge policy becomes what stops strangers reaching a 403, rather than
the only thing stopping them reaching `/admin`.

**The `aud` check is the one that matters on this team.** Anything else behind Access on the same team
domain — Tolgee, today — issues tokens with a valid signature and a valid issuer. Only the audience
tells them apart.

While `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` is unset, every request that did not arrive over the
tailnet is refused. That is deliberate, and it is what makes the window between deploying the gate and
creating the application fail closed.

### What replaced network isolation

The admin surface used to be reachable only over the tailnet, and the argument was that **network
isolation was the first factor and the password the second** — which is why the gate ships without
TOTP. Three things stand in that factor's place, each evaluated per request:

- **An identity assertion**, as above.
- **A challenge**: Turnstile on the sign-in form
  (`src/middleware/admin-login-captcha.middleware.ts`). It identifies nobody; it establishes that a
  human is present before a password is tried, and it sits ahead of the per-username failure budget so
  a bot cannot lock a volunteer out of their own account without solving it.
- **The password**, unchanged.

It is a better first factor than the one it replaces, because it is **a person rather than a device.**
Every phone on the tailnet could reach `/admin/login`. An Access policy is a list of people, revocable
individually and effective immediately, and every request against it is logged by email — which is a
store of personal data outside this deployment, inventoried in
[`data-retention.md`](../security/data-retention.md).

### The Caddy header contract

The tailnet path does not pass through Cloudflare, so there is no assertion for the origin to verify on
it. Caddy vouches for those requests with a header, and the gate stands aside when it sees it:

- **`:8080`** (the Tailscale sidecar's listener) sets `header_up X-Admin-Gate tailnet` on its existing
  `reverse_proxy @admin` block. That matcher also covers `/readyz` and the static prefixes, so the
  header lands on those too — harmless, since the gate is mounted only on the admin paths, and noted
  here so a later reader does not take it for a mistake.
- **`:80`** (the public vhost) sets `header_up -X-Admin-Gate` on its existing `reverse_proxy`, stripping
  any inbound copy. **This is the load-bearing half:** a caller who could set that header from the
  internet would walk straight past the gate.

Both go on the `reverse_proxy` blocks that are already there. **Not a second block scoped to the admin
paths** — that would duplicate `header_up X-Forwarded-For {client_ip}` and `health_uri /healthz` and let
the copies drift. The strip is applied to every public path rather than only the admin ones, because
narrower would mean remembering to widen it when a path is added.

The header is trustworthy for the same reason the `Caddyfile` prefers `{client_ip}` over reading
`CF-Connecting-IP` directly: the only peer that can set it is a listener nothing else on the network can
reach.

### The Turnstile widget on the sign-in form

A **second** widget, not the attendee key. Turnstile keys carry their own hostname allowlist, and the
admin form answers on both `<host>` and the `ts.net` name while both paths stand; adding
`ts.net` to the attendee widget would mean editing the key that carries the door.

- Mode **Managed**, with **both hostnames** listed.
- The origin validates with `expectedAction: 'admin-login'` and no `expectedHostname` — two hostnames,
  and the widget's own domain list is that control. **The client must render the widget with the same
  action**, or every sign-in is refused.
- `TURNSTILE_ADMIN_ENFORCE` switches enforcement, not the widget. `TurnstileValidator` never throws, so
  a Cloudflare outage arrives as an unsuccessful verification and would otherwise close the only surface
  the volunteers have. Set it `false` and restart to stand the check down; put it back afterwards. In production it logs a startup `warn` while off.

---

## Two facts that shape every action choice

**A Managed Challenge cannot be solved from a `fetch`.** Every `/api/v1/checkin/*` call is XHR from
an already-loaded page (`src/web/client/core/api/api.request.ts`). Cloudflare answers a challenge
with an HTML interstitial the browser never renders, so there is nothing for the attendee to click.
That is acceptable for an attacker and is why custom rule 2 still works; it is not a control you would
put
in front of an attendee's happy path.

**Cloudflare sets `cf-mitigated: challenge` on those responses** precisely so XHR callers can
recognise them. `edgeErrorCode` in `api.request.ts` reads it and reports `EDGE_CHALLENGE`.

### A throttle and an expired clearance are not the same failure

This section previously mapped `cf-mitigated: challenge` onto `RATE_LIMITED`, reasoning that a
`fetch` cannot render an interstitial and so the only way through is to wait the window out. That
is true of a **throttle** — a rate limiting rule — where the mitigation lifts on its own.

It is false of the case that actually reaches attendees. Custom rule 2 challenges every request to
this hostname, so every visitor holds a `cf_clearance` cookie minted when they solved it on their first
navigation, and it is only valid for the length of the zone's **Challenge Passage** (Security →
Settings; **16 hours on this zone, read 2026-09-22** — 30 minutes is Cloudflare's default, not this
zone's setting). When it lapses, the next `fetch` is challenged — and **no amount
of waiting mends it.** Only a top-level navigation can render the interstitial and mint a fresh
cookie.

The old mapping made that state unrecoverable *and* unreadable: the app said "Muitas tentativas.
Espera um pouco ⏳", the attendee waited, and nothing changed. The two cases now carry separate
codes, because they need opposite remedies:

| Response                             | Code             | Remedy                             |
| ------------------------------------ | ---------------- | ---------------------------------- |
| `cf-mitigated: challenge` (403 /429) | `EDGE_CHALLENGE` | Navigate — `modules/ui/challenge-gate.ts` raises a prompt whose button reloads |
| Bare 429, no `cf-mitigated`          | `RATE_LIMITED`   | Wait — existing per-step copy      |
| 403 HTML block page                  | `UNKNOWN_ERROR`  | None; a rule is blocking outright  |

`EDGE_CHALLENGE` is client-only and deliberately absent from `src/types/appErrorCode.ts` — it names
a response the origin never produces and never sees.

Two consequences worth keeping in mind:

- **The band loop stops on it.** `modules/ui/band-loop.ts` retries every failure at `BAND_RETRY_MS`
  forever; against a challenged edge that is a request every five seconds that reaches nothing. It
  now settles the band on `stale` and stands down.
- **Challenge Passage is the cheapest lever available, and it has already been pulled.** The
  frontend recovery makes an expired clearance survivable; raising the TTL past the event's duration
  makes it uncommon. Neither replaces the other, and the TTL costs no code. **Read 2026-09-22: it is
  set to 16 hours**, comfortably longer than one evening, so a clearance minted on arrival lasts the
  event. That lowers the odds of meeting an expired clearance during the event; it does not remove the
  case, since a device that cleared on a previous day arrives lapsed. Anything that drops this TTL for
  a test must restore it to **16 hours**, not to the documented default.

_The recovery is only as good as the header._ If a future rule blocks rather than challenges, there
is no `cf-mitigated` and no gate — the attendee gets "Algo deu errado". Prefer Managed Challenge
over Block on anything an attendee's page can reach. Custom rule 1 is the one deliberate exception,
and its section says what it costs.
---

## Accepted consequences

**`admin_session_id` and `checkin_session_id` share an origin.** The tailnet hostname used to separate
them by accident. Cookie-type confusion already
returns 401, because the session type is bound server-side (the
[security overview](../security/security-overview.md#before-every-event-security-checks) re-tests it as check 1),
so this is not a new hole. It is the removal of a layer that existed without anyone choosing it, recorded so nobody later mistakes it for one
that was designed.

**Three clocks run on a volunteer's phone.** The Access session (24 h), `cf_clearance` (Challenge
Passage, 16 h) and `ADMIN_SESSION_TTL` (1 h sliding, 12 h ceiling). The third is the shortest and so the
only one likely to interrupt anybody; it is flagged in [`deployment.md`](../operations/deployment.md) and is not
changed by this arrangement.

---

## Deliberately not used

**A Managed Challenge for non-BR callers instead of custom rule 1's Block.** It would keep the gate
working for a roaming attendee, but rule 2 already challenges everybody, so a non-BR challenge adds
nothing. The Block is there to refuse foreign traffic outright, not to make it prove it is human.

**A configuration rule weakening the admin paths.** Security Level *Essentially Off* and Browser
Integrity Check *off*, scoped to `/admin`, was proposed to sidestep the clearance-expiry problem. It is
rejected: the administrator interface handles challenge expiry the way the attendee interface does, that
keeps working if the challenge is ever raised rather than lowered, and the machinery is already written.

**Cloudflare Access service tokens.** The obvious companion to an Access application, and unnecessary:
every caller of `/api/v1/admin/*` is browser XHR through `src/web/client/core/api/api.request.ts`. There
is no CI here, no cron or timer that speaks HTTP, and the admin CLI scripts connect straight to Postgres
as the migrator role. A browser-based gate breaks no automated caller, so there is nothing for a service
token to carry.

**An Access policy on the whole zone.** It would put an interstitial in front of `/checkin`, the
attendees' own entry path, opened from a WhatsApp webview.

**mTLS or client certificates on the admin path.** Client-certificate validation terminates at
Cloudflare rather than at Caddy, and belongs to API Shield rather than the Free plan — the same two
reasons it is declined for the callback above.

**TOTP on the administrator sign-in.** It needs a secret per administrator, an enrolment flow, a
recovery path for a lost phone and somewhere to keep all three — a week of work on a surface with five
users and one event. Turnstile is the smaller claim that covers what actually has to be stopped: an
automated attempt on a password by a caller that has already cleared Access.

**A `Referer` gate on the API.** `Referer` is offered on custom rules, and every legitimate
`/api/v1/checkin/*` call is a same-origin `fetch` from `/checkin`, so requiring it looks attractive.
It would block every attendee: Helmet defaults to `Referrer-Policy: no-referrer` (`src/app.ts`, not
overridden), so the browser sends no `Referer` at all.

**Managed WAF rulesets.** Enable only if free, and count them as mitigation for nothing — no dynamic
SQL, no uploads, no user-generated HTML. A WAF also cannot detect cookie-type confusion (check 1 of the
[security overview](../security/security-overview.md#before-every-event-security-checks)): a cookie
copied from `checkin_session_id` into `admin_session_id` is a perfectly well-formed request.

**mTLS on the WhatsApp callback.** Meta supports mutual TLS for webhooks and recommends it _over_ IP
allow-listing, which makes it the strongest option on the table and the first thing a reader will
ask about. Declined here for two reasons: client-certificate validation terminates at Cloudflare
rather than at Caddy, so it is an edge feature rather than something the origin could adopt on its
own; and it belongs to API Shield rather than to the Free plan. Revisit if this zone is ever
upgraded — it would retire the callback rule's ASN brittleness entirely.

**An IP-prefix allow-list on the callback.** Meta's documented way to obtain its ranges is
`whois -h whois.radb.net -- '-i origin AS32934'`, roughly two dozen IPv4 prefixes, and Meta warns
in the same breath that they change. A stale list fails closed and silent, which is the same failure
the callback rule already carries, but with a maintenance chore attached and no dashboard to notice
it.
`ip.geoip.asnum` is the same idea with Cloudflare keeping it current.

**A `Referer` or `Origin` gate on the callback.** A server-to-server POST sends neither. This is a
second, independent reason beyond the `Referrer-Policy` one above.

**Pro, for Super Bot Fight Mode and more rules.** ~US$20/month. It would raise custom rules from
five to twenty, retiring most of the budget arguments in this file. Declined on budget; worth
revisiting alongside the mTLS note above, which the same upgrade path unlocks. The Bot Fight Mode
escape routes that were weighed with it are in § _Bot Fight Mode_.

## Verification

What to check after building this configuration, or after any change to it. Results belong to the run
rather than to this file.

- `GET /api/v1/checkin/ticket` is blocked; `POST` is not.
- A first navigation to any path on the hostname other than `/healthz` is challenged, and solving it
  clears the rest.
- `GET /checkin`, `/css`, `/js` and `/assets` are reachable once cleared.
- `curl https://<host>/healthz` answers 200 with no `cf-mitigated` header, with no clearance at all.
- `/admin` and `/api/v1/admin`, unauthenticated in a browser, reach **Cloudflare's Access login** — not
  a block page and not the application's own sign-in form.
- With the Access application disabled, a request to `/admin` gets the **origin's** 403. The two
  refusals are distinguishable: the origin's is `content-length: 9` with `via: 1.1 Caddy` and an
  `x-request-id`, none of which Cloudflare's carries. **This is the check the whole arrangement rests
  on** — that the origin refuses on its own rather than trusting the edge.
- With the application still disabled, `curl -H 'X-Admin-Gate: tailnet'` against `/admin` is also
  refused. That proves the `:80` strip works; without it the gate is bypassable from the internet.
- A token from another application on the same team domain, sent as `Cf-Access-Jwt-Assertion`, is
  refused on `aud`.
- An address not on the policy receives no PIN, and the origin logs nothing.
- An address at a **listed domain** but not on the list also receives no PIN. That distinguishes
  selector *Emails* from *Emails ending in*, and nothing else does.
- Signed in over Access, the first XHR raises no second authorisation.
- `ADMIN_URL` still works end to end from an enrolled tailnet device, with no Cloudflare involvement.
- `/readyz` is 403 on the public hostname and 200 over the tailnet.
- Drop **Challenge Passage** to its minimum, let a clearance lapse with an admin page open, and confirm
  the gate appears, its button reaches a real interstitial, and a POST-rendered page returns to itself
  with no resubmission dialog. Run it in the WhatsApp in-app browser too. **Restore the TTL to 16
  hours.**
- Watch **Challenge Solve Rate** under Security → Security rules during a dry run. A high rate means a
  rule is catching real attendees.
- Watch **Security → Events** through a sign-in and a lookup. An entry naming *Bot Fight Mode* on an
  admin path forces the zone-level decision above.
- Disable custom rule 2 and confirm sign-in is still gated by Access and Turnstile — the contingency
  those exist for. An unauthenticated `curl` then meets Access rather than the challenge, which is the
  only way to see Access itself refuse one. **Re-enable it.**
- Set `TURNSTILE_ADMIN_ENFORCE=false`, restart, and confirm a sign-in with no token succeeds; restore
  and confirm it is refused again.
- Confirm production runs with enforcement on: the app's boot log has no
  `TURNSTILE_ADMIN_ENFORCE is false` warning.
- Replay a spent Turnstile token: refused. Only meaningful against the production widget, since the
  development test secret accepts any token.
- Meta's `GET` verification handshake saves the webhook subscription. That single success proves
  custom rule 4's ASN clause and the callback exclusions in rules 1 and 2 together.
- A request from a non-BR address to any path except the callback prefix returns the Cloudflare block
  page, `/healthz` included.
- A `POST` to the callback path from outside AS32934 returns the Cloudflare block page, not a 403 from
  the origin and not a 200.
- Meta's deliveries appear in **neither** Security Events nor the Challenge Solve Rate. If they do, a
  rule has lost its callback exclusion — check the path prefix in rules 1 and 2 first.
