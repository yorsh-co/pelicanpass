# Overload behaviour

What the application does when it cannot keep up, or when the path between a phone and the server stalls, and
why. The measurements behind the numbers here are in [`load-testing.md`](./load-testing.md#what-the-numbers-mean-for-an-event).

An overloaded server does not fail; it gets slow. Without a bound on either side, every request in flight waits with
it, a phone shows a spinner until Cloudflare's 100-second origin timeout, the person taps again, and the extra
request makes the overload worse. Four mechanisms break that loop:

1. **Load shedding.** The server refuses the excess at once, with `503` and `Retry-After`, instead of queueing it.
2. **A client deadline.** The browser stops waiting at a known point and says so honestly.
3. **Idempotency keys.** The two endpoints a repeated request would duplicate replay their first answer instead.
4. **Re-tap reconciliation.** Every other screen shows what actually happened after a timeout, not a false failure.

At the 2026 event's own load nothing here engages: the event host carries seven times that load before latency
moves. The mechanisms matter past capacity, and on a stalled network path, which a deadline bounds whatever its
cause.

## Load shedding

[`load-shed.middleware.ts`](../../src/middleware/load-shed.middleware.ts), deciding through
[`load.ts`](../../src/shared/telemetry/load.ts) and the pure [`load.policy.ts`](../../src/shared/telemetry/load.policy.ts).

Two signals, decided at different speeds:

- **Event-loop lag**, a histogram that can only be read per window. A sampler reads its **p99** every 500 ms. Two
  consecutive windows over `LOAD_SHED_MAX_LAG_MS` (one second) turn lag shedding on, and every public request is
  refused until ten consecutive windows (five seconds) are back under it.
- **The Postgres pool queue** (`pg.waitingCount`, an array length in `pg-pool`), read on **each request**. A request
  that arrives while more than `LOAD_SHED_MAX_POOL_WAITING` callers wait for a connection is refused; the next one,
  once a connection has come free, is served. A queue at the limit is healthy.

| Variable                        | Default | Meaning                                                                 |
| ------------------------------- | ------- | ----------------------------------------------------------------------- |
| `LOAD_SHED_ENABLED`             | `true`  | Master switch. Never run an event with it off.                           |
| `LOAD_SHED_MAX_LAG_MS`          | `250`   | Worst event-loop stall per half-second window before lag shedding starts |
| `LOAD_SHED_MAX_POOL_WAITING`    | `20`    | Callers queued for a connection before a new request is refused (pool of 10) |
| `LOAD_SHED_RETRY_AFTER_SECONDS` | `5`     | What a refused client is told to wait                                    |

Never shed: `/healthz`, `/readyz` and the static files, which are mounted ahead of the middleware (shedding
`/healthz` would have Caddy eject the only upstream), and the administrator surface, `/admin` and `/api/v1/admin`,
which is low volume and is what an operator needs most while the public surface is being shed.

A refusal is `503` with `Retry-After` and `Cache-Control: no-store`: the styled busy page for a page request (no
action button, for the reason the `429` page has none), the `SERVICE_UNAVAILABLE` JSON envelope under `/api/`.

**Reporting.** Each refusal counts as `http.shed`, never as `http.5xx`, and stays out of the latency histogram,
where a 1 ms answer would pull it towards "fast" during an overload. Above 20 a minute, the `load:shedding` alert
fires. A separate streak machine, fed by lag or any refusal in a tick, decides when shedding of either kind started
and stopped: one `Load shedding started` / `stopped` log line each, with `lagMs`, `poolWaiting` and the tick's
`sheds`, recorded as `LOAD_SHED_ON` / `LOAD_SHED_OFF` events. The load-test harness parses the start line; keep its
message and fields.

Why it is built this way:

- **p99, not the mean.** A blocked loop ticks less, so a 150 ms stall is one histogram sample among several near zero.
  The mean read about 30 ms under an injected 150 ms stall and never tripped.
- **The refusal bypasses the error handlers.** Both log every 5xx at `error` and write an event row: a log line and a
  database write per refused request, at exactly the moment the process cannot afford either.
- **Lag holds for five seconds.** Stopping after one healthy second let demand return within two, about ten on/off
  cycles a raffle draw.
- **The pool queue is checked per request, not behind a flag.** A flag refused every public request for at least five
  seconds, and refusing everything emptied the queue, so the sampler stopped seeing demand. On the event host, per
  request served 13 to 16 points more of the room past the knee than the flag did, with p99 better on every rung
  and the queue held at 18–32 instead of 52–314 when shedding started. Served p95 rose, to 575 ms at `SCALE=20`,
  because the requests the flag refused, which waited at least five seconds each, are now served in about half a
  second.

A request that passes the check joins the queue at its first query, so a burst admitted together can still overshoot
the limit somewhat. Raffle's limit is the app's one CPU core, not the database: holding the queue near the limit
bounds the waiting, not the CPU.

## Every bound on a request's path

| Layer                                                             | Bound                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Client `request()` ([`api.request.ts`](../../src/web/client/core/api/api.request.ts)) | 15 s, headers and body together                                        |
| Admin attendee create and update                                  | 30 s: the door message awaits a Meta send (`WHATSAPP_REQUEST_TIMEOUT`, 10 s) after the database work |
| Check-in verification                                             | 30 s, to keep the session-rotation gap rare (below)                                     |
| Admin readiness probe (`readiness()`)                             | 12 s: above `/readyz`'s own worst case, a 5 s wait for a connection plus a 5 s query    |
| Cloudflare to origin                                              | 100 s, then `524`                                                                       |
| Caddy, idle upstream connection                                   | 30 s (`transport http { keepalive 30s }`)                                                |
| Caddy, wait for upstream response headers                         | 50 s (`response_header_timeout`), then `504`: above the 30 s client deadline and the ~40 s slowest handler, below Cloudflare's 100 s. Frees the connection; the handler still runs |
| Node, idle keep-alive connection ([`server.ts`](../../src/server.ts)) | 35 s, so Caddy always closes first and never sends a request down a closing connection  |
| Postgres pool ([`postgres.ts`](../../src/shared/db/postgres.ts))     | 10 connections; `connectionTimeoutMillis`, `statement_timeout` and `query_timeout` 5 s each |
| Redis ([`redis.ts`](../../src/shared/db/redis.ts))                   | `commandTimeout` 1 s                                                                    |

The client's 15 s is deliberately not above every server path: a captcha'd ticket submit can spend 5 s waiting for
a connection, 10 s on `siteverify` and 5 s on a statement. Those steps are safe to repeat, so giving up first costs a
re-tap, not a duplicate. Node's `requestTimeout` and `headersTimeout` stay at their defaults: they bound how long a
client may take to *send* a request, not how long a handler runs, and behind Caddy and Cloudflare they add nothing.

## The client deadline

A request that passes its deadline fails as `EDGE_TIMEOUT`
([`api.error.ts`](../../src/web/client/core/api/api.error.ts)): the client stopped waiting, and the server may still
have done the work.

- **A manual `AbortController`, told apart by a flag.** The timer sets a local `timedOut` flag before it aborts, and
  both catches (around `fetch` and around `res.json()`) branch on the flag, not on the error. `AbortSignal.timeout`
  needs iOS 16, and `abort(reason)` passes its reason through only from Safari 15.4, while the attendee surface
  still serves iOS 15. The timer is cleared in a `finally`, so every exit clears it and a body that stalls after the
  headers stays under the same deadline. `signal` is not accepted from callers, since one would silently replace the
  deadline.
- **A timeout never raises the challenge gate.** Only `EDGE_UNREACHABLE`, a request that never completed, does. A slow
  server must not read as an expired session.
- **Neutral copy.** On the screens a request fails on (check-in ticket, verification and scanner, the staff scanner
  and redeem), `EDGE_TIMEOUT` and `SERVICE_UNAVAILABLE` read "A resposta demorou demais. Tente novamente em
  instantes". On the day a stall is likelier to be the network than the server, so the copy blames neither. Both
  codes are kept out of client error reporting.
- **The band loop backs off with jitter.** After a failed refresh the pass and staff band loops wait the larger of
  5 s and the server's `Retry-After`, multiplied by a random factor from 1 to 1.5
  ([`pacing.ts`](../../src/web/client/modules/ui/pacing.ts)). Without the jitter, every phone refused in the same second
  would retry in the same second, just after shedding stops, and trip it again. A 401 or a challenged edge still
  stops the loop.

## Repeating a request after a timeout

A deadline frees the browser; it does not cancel the server's work. A request that timed out may have committed.
The client never retries a mutation by itself, so the question is what a person's re-tap does.

| Endpoint                                   | Safe to repeat?                | After a timeout that went through                                                                                    |
| ------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/attendees`                    | **By key**                     | Replays the attendee the first attempt created, door-message outcome included                                        |
| `POST /raffle/draw`                        | **By key**                     | Replays the number already drawn                                                                                     |
| `POST /checkin/ticket`, `/checkin/qr`      | By construction                | Short-circuits on the session's progress; `completeCheckin` returns the number it already issued                     |
| `POST /checkin/presence`                   | By construction                | Short-circuits on the session's progress; `completeCheckin` returns the number it already issued                     |
| `POST /checkin/verification`               | With a gap                     | The rotated session cookie arrived with the discarded answer. The step reloads after a timeout; see below            |
| `POST /staff/redeem`                       | By construction                | A conditional update hands nothing out twice; answers `duplicate`, which the screen reconciles                       |
| `POST /raffle/reset`                       | By construction                | `NOT_FOUND`, since the draw is already cleared; the screen re-reads the list                                         |
| `POST /admin/whatsapp/runs`                | By construction                | The preview token was spent, so "preview expired"; the screen reads the current run                                  |
| `POST /survey`                             | By construction                | `SURVEY_ANSWERED`, which the screen reconciles                                                                       |
| Admin redemption corrections               | By construction                | Refused before writing (`itemAlreadyRedeemed` and similar); the record re-renders                                    |
| `PATCH /admin/attendees/:id`               | By construction                | Writes the same values; a ticked door message reports `alreadySent`. Cosmetic                                        |
| `POST /admin/whatsapp/test`                | No                             | Another test message. Acceptable                                                                                     |
| Everything else                            | By construction                | Sets a fixed state, or only reads                                                                                    |

### Idempotency keys

[`idempotency.ts`](../../src/middleware/idempotency.ts), wired to Redis by `idempotency.middleware.ts`, mounted as
`idempotent(scope)` after the route's session and permission checks. The client sends `Idempotency-Key: <uuid>` and
keeps the same key for every tap of one action; any edit to the form, or a change of the raffle's repeats box,
starts a new one.

- The first request claims `idem:<scope>:<actor ID>:<key>` with `SET NX`, pending for 60 s, above the longest handler
  (a create with the door message, about 40 s at worst). A repeat while it runs gets `409` with
  `requestInProgress`.
- The handler's answer is stored before it is sent. A `2xx` is kept for 10 minutes and replayed with
  `Idempotent-Replay: true`; any other answer releases the key, so a genuine retry runs.
- The key is scoped to the session's database ID, so one actor can never replay another's response. Not the session
  ID, which would put a live credential into the keyspace.
- The body is hashed into the record; the same key with a different body is a `400`.
- No header, or a Redis failure, runs the request as before. Without Redis there are no sessions, so refusing would
  protect nothing.

The stored records are listed in [`data-retention.md`](../security/data-retention.md).

### Re-tap reconciliation

Each screen that can **re-read** what happened does so after a timeout, waiting 3 s first (`RESYNC_DELAY_MS`) so it
reads the outcome rather than racing a handler still running:

- **Raffle reset** re-renders the draw list, and does the same on `NOT_FOUND`.
- **WhatsApp start** reads the current run; a run other than the one on screen before the press is this one.
- **Admin redemption correction** says it is checking and re-renders the record.
- **Check-in verification** reloads, so the server renders the step the browser is really on: verification again if
  it never ran, the ticket step if the rotated cookie was lost. Every step is safe to repeat.

Two screens cannot re-read, and remember a timed-out action for 60 s instead
([`retap.ts`](../../src/web/client/modules/ui/retap.ts)). Inside that window the refusal its own success causes is shown
as that success; past it, the same refusal is more likely somebody else's action and keeps its copy.

- **Staff redeem**, keyed on the card's identifier and the item, since a re-scan replaces the handle. A `duplicate`
  shows as "Retirado". It leaves one extra `duplicate` audit row, which
  [`db-cheatsheet.md`](../operations/db-cheatsheet.md) notes.
- **The survey**: `SURVEY_ANSWERED` gets the thanks toast.

## Known gaps

- **The lag limit is untested under load.** In every k6 session only the pool signal tripped; `LOAD_SHED_MAX_LAG_MS`
  has been exercised only by an injected busy-wait.
- **`shed_starts` changed meaning** in October 2026, from flag flips to reporting episodes, so it does not compare
  across that change in [`load-test-results.md`](./load-test-results.md). `pool_waiting_at_start_max` does.
- **The verification gap stays open: won't fix, by decision.** A verification that succeeds after the client deadline
  loses its rotated cookie, so the reload lands on the ticket step again. That happens only past capacity or on a
  stalled network path. A single-use grace pointer from the old ID would close it but weakens the rotation defence;
  the analysis is in the archive: `git show 38d4f8a:docs/todo.md`, §18.
