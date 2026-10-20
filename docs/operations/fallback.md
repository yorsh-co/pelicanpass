# Landing Fallback

A standalone server that keeps the public hostname answering while the production stack is
restarted in the hours around the event. It runs on any machine with Docker, or Node 24, and needs
no database, no cache and none of the production secrets.

For a full copy of the app that keeps check-ins and sessions while the production host is down for
longer, see [`standby.md`](./standby.md).

---

## 1. What it serves

| Path                             | Answer                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/privacy`, `/terms`             | The same notices the live app renders                                                                             |
| `/healthz`                       | `{ "status": "ok" }`, for the container healthcheck                                                               |
| Static files                     | The same stylesheets, bundle, fonts and images                                                                    |
| `/api/**`, any non-`GET` request | `503` with `Retry-After: 30`, in the API's JSON error envelope; `410 EVENT_CLOSED` after `EVENT_CLOSES_AT`        |
| Every other `GET`                | The landing countdown, **in place** — never a redirect — and `no-store`; the closing page after `EVENT_CLOSES_AT` |

Rendering in place keeps `?audience=` and avoids a redirect. The landing page strips `t` and `k` from
the address bar on load, so a WhatsApp entry link (`/checkin?t=…`) does not survive the wait: after a
fallback window the attendee taps the link again or types their code. `no-store` is what stops
Cloudflare or a phone keeping the curtain once the live app is back.

The countdown is the live app's, from the same `.env` values and `?audience=` rule. When it reaches
zero the fallback cannot send anybody to check in, so it swaps the clock for a notice (`landing.reopening`)
and reloads the page after 30 s plus a random slice of 90 s. Each device therefore lands on the live
app shortly after it returns, spread out rather than all at once through the venue's single NAT
address. A page loaded after zero renders the notice straight away.

The fallback has no sessions, so an attendee who already checked in sees the curtain too, until the
live app is back.

Locale is fixed to pt-BR, which is the only locale production offers.

There is no application rate limiter. The live app's `webLimiter` exists because every render costs
a Redis session lookup; here a render touches nothing but memory. A per-IP limit would key on the
venue's single NAT address, which also carries the whole room's reloads after zero, so it would
refuse attendees before it refused an attacker. Flood protection is Cloudflare's, as it is for the
live app — see [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md).

## 2. Prepare the fallback machine — before the event

1. **Create a dedicated Cloudflare tunnel** for the fallback in Zero Trust → Networks → Tunnels. Do
   **not** reuse production's `TUNNEL_TOKEN`: two connectors on one tunnel are load-balanced, which
   would send half of the live traffic to the fallback while production is healthy.
2. Clone the repository and check out **the same tag production runs**:

   ```sh
   git clone https://github.com/yorsh-co/pelicanpass.git && cd pelicanpass
   git checkout <production tag>
   ```

3. Create `.env` from the example and fill it in. The timing lines are copied from the production
   `.env` unchanged; `TUNNEL_TOKEN` is the fallback tunnel's.

   ```sh
   cp .env.fallback.example .env && chmod 600 .env
   ```

   `COMPOSE_FILE=compose.fallback.yml` in that file makes a bare `docker compose` target the fallback
   stack on this machine.

4. Build and start it, and confirm it is healthy:

   ```sh
   docker compose up -d --build
   docker compose ps          # app: healthy
   docker compose exec app wget -qO- http://127.0.0.1:3000/healthz
   ```

   Running it ahead of time costs nothing: its tunnel carries no traffic until a hostname is routed
   to it.

5. In the fallback tunnel's configuration, route a **spare hostname** (for example
   `fallback.<domain>`) to `http://app:3000` and open it on a phone to rehearse the page.

### Without Docker

```sh
npm ci && npm run build && npm prune --omit=dev
EVENT_START_AT=2026-09-13T19:00:00-03:00 npm run fallback
```

`npm run fallback` also reads a `.env` in the working directory. Put the machine behind the fallback
tunnel with `cloudflared tunnel run --token …` pointed at `http://localhost:3000`.

## 3. Cut over

1. Route the public hostname (`SITE_HOST`) to the **fallback** tunnel: remove it from the production
   tunnel's public hostnames, then add it to the fallback tunnel's, pointing at `http://app:3000`.
   The dashboard rewrites the hostname's DNS record to the fallback tunnel.
2. Confirm through the public hostname that the countdown loads.
3. Restart or repair production.

The zone's WAF and custom rules ([`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md)) keep applying,
because the hostname and zone are unchanged.

## 4. Cut back

1. Confirm production is ready over the tailnet (`/readyz` → `ready`).
2. Move the public hostname back to the production tunnel, reversing §3.1.
3. Watch the live app's traffic return as fallback pages reload. Leave the fallback running; it is
   idle without a hostname.

## 5. The closing page

From `EVENT_CLOSES_AT`, the live app and the fallback both replace the site with a thank-you page
(`pages/closing`, copy in `landing.closed.*`). On the live app it covers `/`, `/pass`, `/checkin`,
`/staff` and `/raffle` with no session bypass, and the attendee API answers `410 EVENT_CLOSED`. The
browser reloads on that code, so a pass left open lands on the closing page at its next poll.
`/admin`, `/privacy` and `/terms` are untouched.

Here it covers every page path, and `/api/**` answers the same `410`. That is what the fallback is
for after the event: teardown destroys the production host, and without an origin the public
hostname shows a Cloudflare error. Copy the `EVENT_CLOSES_AT` line from the production `.env` into
this machine's `.env`, and cut over (§3) **before** `docker compose down -v` — see
[`deployment.md` § Teardown](./deployment.md#teardown). The page stays up for as long as this machine
and its tunnel run.

After the event, the [static closing site](./static-site.md) replaces the fallback: it serves the
same page from Cloudflare Pages, so no machine has to keep running.
