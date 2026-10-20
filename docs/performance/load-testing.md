# Load testing

The 30-person dry run cannot show whether the rate limits and the host hold for the real event: 500
participants and 200 volunteers. This harness replays the event's phases at their real rates
against a copy of the production stack, and answers two separate questions:

1. **Limiter balance.** Does a real crowd get a `429` or a captcha it should not?
2. **Host capacity.** With the limiters out of the way, how much headroom is there?

It lives in [`loadtest/`](../../loadtest) (k6, TypeScript), [`scripts/loadtest/`](../../scripts/loadtest)
(roster, reset, the ladder runner and the results report) and
[`compose.loadtest.yml`](../../compose.loadtest.yml). Every run through the ladder runner, limiter and
capacity alike, is recorded one row per rung in `loadtest/history/` and compared in the generated
[`load-test-results.md`](./load-test-results.md). [How a session is recorded and
judged](#how-a-session-is-recorded-and-judged) has the method, and [A full session, from
scratch](#a-full-session-from-scratch) the steps.

## What to expect before running anything

The brief, set against the quotas in `src/config/rate-limits.ts`. It assumes the worst case, which is
the whole room on venue Wi-Fi behind **one public address**, and peaks at about three times the
average.

| Phase                                     | Load at `SCALE=1`                                    | Limit that binds                                                                          | Expected on defaults                           |
| ----------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Participant check-in (500 in 30–45 min)   | 8/min, 36/min from minute 5 to 15                    | `rl:ip:checkin-entry` 60/min per IP; a link costs 2 (link + 303), a typed ticket 1 → ~58/min at the peak | At the limit; any extra burst is refused       |
|                                           | 3 renders by link, 2 typed → ~94/min at the peak     | `rl:ip:web` 300/min per IP                                                                | Headroom                                       |
|                                           | 2 API calls by link, 3–4 typed → ~110/min            | `rl:ip` 300/min per IP                                                                    | Headroom                                       |
|                                           | 10% of typed tickets mistype once (the dry run's rate) → ~1.5/min at the peak | `rl:global:checkin-entry-failures` 30/min, **global**, puts a captcha in front of everyone | ~5% used; a bad minute at the door trips it    |
|                                           | 10% of all check-ins mistype the code once (the dry run's rate) | `rl:attendee:verification-failures` 10 per 15 min per attendee; the session's captcha after 5. Not the global budget | Headroom                                       |
| Redemptions (10 counters × 6/min)         | 60/min, 2 API calls each, plus band and pass polls   | `rl:session:staff` 60/min per volunteer (~14 used)                                        | Headroom                                       |
| Raffle (one drawer, the room checks)      | ~600 pass-page loads in 60 s after each draw         | `rl:ip:web` 300/min per IP                                                                | **Half the room refused**                      |
| Survey (500 in 5 min, front-loaded)       | ~180 in the first minute, each a page load + submit  | submit: none per IP (exempt); page load: `rl:ip:web` 300/min                             | Headroom; the DB's peak                        |
| Pass front polls (redemptions: a third of the room; raffle and survey: all of it) | ~334/min, ~1,000/min | `rl:session:attendee` 30/min per session (2 used); exempt from `rl:ip` | Headroom |

The front polls run alongside the phase they belong to. They were added after the 2026-09-29 dev-server
session, which changed `harness_tree`, so the report keeps results from before and after apart.
`rl:ip:web` was 100/min until 2026-09-30; at 100, check-in sat at the limit and most of the raffle
and the survey's first minute were refused. The 2026-09-30 session's runs 1 to 3 were measured at
100.

The lever already exists and needs no release: the venue's egress address in `TRUSTED_IPS` moves it
to the `:trusted` tiers (600 / 1,000 / 2,000 a minute). The test's first job is to prove this table,
and its second is to prove that fix.

The smoke run measured the real request counts. A check-in costs **5** limited requests by link or
by typed ticket, one more for each mistyped ticket or code, plus about 10 static files, which no
limiter sees.

## Where it runs

- **Not through the public hostname.** Cloudflare's Managed Challenge, Bot Fight Mode and the
  non-BR block stop any script ([`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md)).
- **On the event host, or an identical one**, so the hardware numbers mean something, and **outside
  event hours**. `compose.loadtest.yml` is a separate project (`pelicanpass-loadtest`) with its
  own volumes and unpinned networks, so it runs beside the event stack without touching it. The two
  still share CPU, memory and disk.
- **With nothing else running on the host.** The app is one Node process, so anything competing for
  the host's CPU or heat budget shows up as app latency. A desktop session with a few heavy browser
  tabs on the same machine turned a raffle rung's served p95 from 13 ms into 131 ms. The ladder
  runner measures this: a rung with more than a core of other load (p95) or a second of thermal
  throttling is marked invalid, with the busiest processes named, and run again.
- **On a hybrid CPU, with the app pinned to the performance cores** (`--app-cpuset`). A
  single-threaded Node process scheduled onto an efficiency core runs slower, and the scheduler's
  choice would otherwise vary between rungs. The performance cores are listed in
  `/sys/devices/cpu_core/cpus`; on an i7-1260P they are `0-7`. Without efficiency cores, nothing is
  pinned.
- **k6 talks to `app:3000` directly.** The app trusts one proxy hop, so k6's `X-Forwarded-For` is
  `req.ip`, which is how one container plays a whole room.
- **What the stack changes from production.** Alerts and Discord are off, WhatsApp is off, the landing
  gate is open, the event never closes (`EVENT_CLOSES_AT` is cleared, whatever the `.env` holds),
  Turnstile uses Cloudflare's always-pass pair, the participant survey is open, and `APP_URL` is
  `http://app:3000`: k6 sends that origin as `Origin` on every non-GET request, which the same-origin check
  requires.
  Everything else (image, Postgres tuning, pool, read-only root, log caps) is `compose.prod.yml`'s.

## Setting up

From a clone of the repository (not a git worktree, since the image build reads `.git`), with the
event's `.env` in place. The host needs Docker with Compose and Node 24 or later; the runner, roster
and report use Node's built-ins only, so the clone needs no `npm ci`.

```bash
mkdir -p .ignore
docker compose -f compose.loadtest.yml up -d --build
docker compose -f compose.loadtest.yml --profile tools run --rm --build migrate

node scripts/loadtest/roster.ts > .ignore/loadtest-roster.csv
docker compose -f compose.loadtest.yml --profile tools run --rm -T migrate \
  node scripts/db/import-attendees.ts < .ignore/loadtest-roster.csv
```

The roster is 500 participants (`lt0000`…) and 200 volunteers (`vlt000`…), each entitled to the first
approved option of every item. `--participants` and `--volunteers` change the counts.

For capacity runs, import one roster large enough for every phase, once:
`roster.ts --participants 10400`. Survey needs a participant per arrival, 520 × `SCALE` up to
`SCALE=20`, and raffle one per phone on the pass front, 500 × `SCALE`. Each phase takes only what it
needs through `PARTICIPANTS` (below), so the same roster serves all of them. Importing adds rows; it
never removes any.

The importer refuses more than 5,000 data rows ([`imports.md`](../operations/imports.md)), so a
roster that size goes in in chunks, as in step 3 of
[A full session, from scratch](#a-full-session-from-scratch). A code already imported is reported
unchanged, so a chunk can be repeated, and a larger roster can be imported over a smaller one.

`--build` on `migrate` is not optional after a pull: `run` reuses the image it built last time, and
an image from before a new migration fails the reset with a missing column. The app's own image
cannot migrate, since `node-pg-migrate` is a dev dependency it does not carry.

## Before every run: reset

Each run starts from doors-closed: no check-ins, redemptions, draws or answers, and **empty Redis**,
because limiter counters and sessions left from the last run would skew the next. The ladder runner
does this itself before every rung; the commands below are for a run started by hand.

```bash
set -a; . ./.env; set +a

docker compose -f compose.loadtest.yml exec -T db psql \
  -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" -v event_id="$EVENT_ID" \
  < scripts/loadtest/prepare.sql > loadtest/fixtures.json

docker compose -f compose.loadtest.yml exec cache \
  redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL
```

`prepare.sql` also grants redeem rights to `vlt000`–`vlt009` and draw rights to `vlt00a`, and
prints the fixtures (ticket, verification code, entry-link token) k6 reads. **It refuses to run if the
event holds any attendee whose code is not synthetic**, so it cannot reset a real roster.
`loadtest/fixtures.json` holds live link tokens and is ignored by git.

## Running

```bash
docker compose -f compose.loadtest.yml --profile tools run --rm k6 run \
  -e PHASE=checkin-participants -e IP_MODE=single \
  --summary-export=/results/checkin-participants-single.json run.ts
```

| Setting     | Default        | Meaning                                                                                        |
| ----------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `PHASE`     | —              | `checkin-volunteers`, `checkin-participants`, `redemptions`, `raffle`, `survey`                 |
| `IP_MODE`   | `single`       | `single`: one venue address. `cgnat`: `WIFI_SHARE` on the venue address, the rest evenly over `CARRIER_IPS` carrier addresses. `spread`: one each |
| `VENUE_IP`  | `203.0.113.10` | The venue address. Put the same value in `LOADTEST_TRUSTED_IPS` to test the fix                  |
| `WIFI_SHARE` | `0.7`         | `cgnat` only: share of the room on venue Wi-Fi, from 0 to 1                                     |
| `CARRIER_IPS` | `10`         | `cgnat` only: carrier addresses the rest of the room shares, 1 to 254. Fewer means more phones behind each |
| `SCALE`     | `1`            | Multiplies every arrival rate, up to 20. Above 1, attendees are reused unless the roster is larger (second-phone check-ins, `409` survey resubmits) |
| `PARTICIPANTS` | all         | Participants to take from the start of the fixtures. k6 refuses to start if they hold fewer    |
| `TYPO_RATE` | `0.1`          | Share of typed tickets mistyped once first. The 2026-09-26 dry run's rate, from 28 check-ins    |
| `CODE_TYPO_RATE` | `0.1`     | Share of all check-ins that mistype the verification code once first. The dry run's rate        |
| `LINK_RATE` | `0.6`          | Share of check-ins through the WhatsApp entry link                                             |
| `ASSETS`    | `true`         | Fetch each page's stylesheets and scripts on a check-in                                        |
| `SMOKE`     | `false`        | Run each scenario once. Always do this first after a change                                    |

`redemptions`, `raffle` and `survey` check their attendees in during `setup()`, each from its own
address, and those requests are excluded from every threshold. Phases run 5 to 30 minutes.

The server-side variables under test are read when `app` starts, from the shell:

```bash
LOADTEST_TRUSTED_IPS=203.0.113.10 docker compose -f compose.loadtest.yml up -d app
LOADTEST_RATE_LIMIT_OVERRIDES='rl:ip:web=300/60' docker compose -f compose.loadtest.yml up -d app
LOADTEST_LOAD_SHED_ENABLED=false docker compose -f compose.loadtest.yml up -d app
LOADTEST_LOAD_SHED_MAX_LAG_MS=125 LOADTEST_LOAD_SHED_MAX_POOL_WAITING=10 \
  docker compose -f compose.loadtest.yml up -d app
```

The `LOADTEST_LOAD_SHED_*` variables set `LOAD_SHED_ENABLED`, `LOAD_SHED_MAX_LAG_MS` and
`LOAD_SHED_MAX_POOL_WAITING`. Left unset, each falls back to the code's default, not the event `.env`'s.
`LOAD_SHED_RETRY_AFTER_SECONDS` is not passed through: the scenarios ignore `Retry-After`, so a run
cannot measure it.

## The runs, in order

Reset before each one. Load shedding is on at its defaults unless a run says otherwise, so runs 1 to
3 should show `shed` at 0. A shed there means the room at its real size trips the limits, which is a
finding in itself.

Runs 1 to 3 go through the ladder runner as well, one session per phase at `--scales 1`. It resets
before every rung and records each, and the report's **Limiter balance** lines them up, so a quota or
k6 change later reads beside the run before it. A hand run ([Running](#running)) still works but
records nothing.

1. **Baseline:** defaults, `IP_MODE=single`, every phase. Expect `raffle` to fail on
   `rate_limited`, and participant check-in to sit at or just over its limits, as the table above
   predicts. If they do not, the harness is
   not doing what a phone does, so stop and find out why.
2. **The fix:** `LOADTEST_TRUSTED_IPS=203.0.113.10`, `IP_MODE=single`, every phase. All thresholds
   should pass. Watch `captcha_required` on participant check-in. If the global failure budget trips,
   weigh an override of `rl:global:checkin-entry-failures` against its brute-force rationale in
   [`rate-limiting.md`](./rate-limiting.md) before touching it.
3. **A mixed room:** defaults, `IP_MODE=cgnat`, which puts 70% on the venue address and the rest
   over ten carrier addresses. This checks the strict tier on the biggest shared address. Repeat
   with the mix the dry run suggests, mostly on mobile data
   (`--k6-env WIFI_SHARE=0.15 --k6-env CARRIER_IPS=5`), and with one dominant carrier
   (`CARRIER_IPS=2`), where a carrier address is the biggest.

   The commands for all three are in [A full session, from scratch](#a-full-session-from-scratch). A
   quota under test goes in `--env RATE_LIMIT_OVERRIDES='rl:ip:web=300/60'`, which the row records
   with its value. `TRUSTED_IPS` is recorded only as set: the venue's address stays out of the
   repository.
4. **Capacity**, through the ladder runner, from the clone's root. Shedding off, so this finds the
   host's own limit: the **knee**, the first `SCALE` where `served_duration` fails its threshold or
   `server_errors` rises. Survey and raffle are the ones that matter. `LT_HOST` and `LT_CPUSET` are
   set as in step 1 of [A full session, from scratch](#a-full-session-from-scratch).

   ```bash
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase raffle --shedding off --find-knee \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"}
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase survey --shedding off --find-knee \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"}
   ```

   Each is a session: the runner rebuilds the app once, doubles `SCALE` until a rung fails, bisects to
   the knee and runs either side of it twice, resetting before every rung and recording each in
   `loadtest/history/`. About an hour a phase. Survey takes 520 × `SCALE` participants, one per
   arrival, and raffle 500 × `SCALE`, one per phone, so no session is shared and
   `rl:session:attendee` never binds; every other phase takes 500. A phase that passes at `SCALE=20`
   has no knee on this host.
5. **Overload:** shedding on, from each knee up. One session per configuration, the defaults first:

   ```bash
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase raffle --scales 14,16,20 \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"}
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase raffle --scales 14,16,20 \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"} --env LOAD_SHED_MAX_POOL_WAITING=10 --note "pool 10"
   ```

   Use the knee run 4 found for the first scale. Survey loads the pool queue and raffle loads the event
   loop, so between them they exercise both signals. The runner records served latency, shed and
   failure rates, the shedding starts with the `lagMs` and `poolWaiting` that tripped them, container
   and host CPU, and `pg_stat_activity`. Then judge the limits:
   - **Shedding starts only past the knee**, where served latency had already failed: the limits are
     too loose. Halve the one that tripped, and rerun at the knee.
   - **Shedding starts well below the knee**, at a scale run 4 served healthily: the limits are too
     tight. Raise the one that tripped, and rerun.
   - **The target:** at every scale from the knee up, `served_duration` within its threshold,
     `server_errors` and `flow_failed` at 0, and no more than about one on/off cycle a minute.
     Sustained flapping at the chosen limits is a finding about `SAMPLES_TO_STOP` in
     `src/shared/telemetry/load.policy.ts`, which is code, not a setting.

**Done when** run 2 passes at `SCALE=1` with no unintended `429`, run 4 holds `SCALE=3` on survey
and raffle, and run 5 meets its target. The limits run 5 settles on become the defaults in
`src/config/env.ts` and `.env.example`. After every session, `npm run loadtest:report` regenerates
[`load-test-results.md`](./load-test-results.md): commit it with the session files, since
`npm run check` fails while it is stale.

## A full session, from scratch

All five runs on one host, from an empty stack, every rung recorded: two sittings, about five hours
for runs 1 to 3 and three for runs 4 and 5. Each rung lands in `loadtest/history/`, and the report
compares it with every session before and after: runs 1 to 3 under **Limiter balance**, runs 4 and 5
under **Capacity** and **Shedding past the knee**. A later session repeats the same steps, so its
lines read beside these. On a host that has never run one, start with
[First session on a new host](#first-session-on-a-new-host).

Steps 3 to 8 can run unattended with `scripts/loadtest/session.sh`
([Running steps 3 to 8 in one go](#running-steps-3-to-8-in-one-go)). The numbered steps stay the
reference, and the way to run any of them by hand.

1. **Name the host and clear it**, for both sittings. The commands below read two variables, which a
   new shell does not keep, so set them again at the start of each sitting:
   - `LT_HOST` is the label the report groups this machine's rows under: lower-case letters, digits
     and dashes, and the same every session.
   - `LT_CPUSET` is the performance cores to pin the app to, from `cat /sys/devices/cpu_core/cpus`
     on a hybrid Intel CPU. Leave it empty on a CPU without efficiency cores, or where rootless
     Docker has not delegated the `cpuset` controller and `docker update --cpuset-cpus` fails.

   Close the browser, the editor and anything else busy, and leave the host alone until the last
   rung. A rung with more than a core of other load is rerun, so a busy host costs time; three in a
   row stop the session. The throttle check below should print close to 0 ms. On a laptop, run on
   mains with the battery at or under its charge limit: above it, the 2026-09-29 test laptop's
   firmware ran from the battery and throttled one busy core for 7 s in 15, and every rung above
   `SCALE=1` came back invalid.

   For an unattended session, the pre-flight in
   [Running steps 3 to 8 in one go](#running-steps-3-to-8-in-one-go) applies too.

   ```bash
   LT_HOST=…                                    # e.g. prod-server
   LT_CPUSET=                                   # e.g. 0-7 on a hybrid CPU; empty otherwise
   cat /sys/class/power_supply/BAT0/capacity    # laptops: at or under the charge limit
   f=/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_total_time_ms
   a=$(cat $f); taskset -c 2 timeout 15 sh -c 'while :; do :; done'; echo "$(( $(cat $f) - a )) ms"
   ```

2. **Update the clone** to the commit to measure, with `git status` clean. A dirty tree is recorded as
   such, and its rungs compare only with runs carrying the same change. The clone pulls from
   `origin`, so push what is to be measured to `origin/develop` first. A clone on the development
   machine can pull from the working checkout's path instead.

   ```bash
   cd pelicanpass-loadtest
   git status --short                 # prints nothing
   git switch develop
   git pull --ff-only origin develop
   ```

3. **Rebuild the stack from empty**, about 15 minutes. `down -v` takes the synthetic roster, the
   Redis data and the load-test logs; the committed history is untouched. The roster covers survey's
   520 × `SCALE` and raffle's 500 × `SCALE` up to `SCALE=20`.

   ```bash
   set -a; . ./.env; set +a
   mkdir -p .ignore
   docker compose -f compose.loadtest.yml down -v
   docker compose -f compose.loadtest.yml up -d --build --wait
   docker compose -f compose.loadtest.yml --profile tools run --rm --build migrate

   node scripts/loadtest/roster.ts --participants 10400 > .ignore/loadtest-roster.csv
   head -1 .ignore/loadtest-roster.csv > .ignore/roster-header.csv
   rm -f .ignore/roster-part-*
   tail -n +2 .ignore/loadtest-roster.csv | split -l 5000 - .ignore/roster-part-
   for f in .ignore/roster-part-*; do
     cat .ignore/roster-header.csv "$f" |
       docker compose -f compose.loadtest.yml --profile tools run --rm -T migrate \
         node scripts/db/import-attendees.ts || break
   done
   ```

   The 10,600 rows go in as three imports, since the importer takes at most 5,000 data rows at a
   time.

4. **Smoke every phase by hand**, not through the runner: `--smoke` rungs are recorded like any
   other, and would read as passing limiter runs. Every phase should end with every threshold
   passed; stop at the first that does not, since the harness or the app has changed under it.

   ```bash
   smoke() {
     docker compose -f compose.loadtest.yml exec -T db psql \
       -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" -v event_id="$EVENT_ID" \
       < scripts/loadtest/prepare.sql > loadtest/fixtures.json || return
     docker compose -f compose.loadtest.yml exec -T cache \
       redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL || return
     docker compose -f compose.loadtest.yml --profile tools run --rm -T k6 run \
       -e PHASE="$1" -e SMOKE=true run.ts
   }
   for p in checkin-volunteers checkin-participants redemptions raffle survey; do smoke "$p"; done
   ```

5. **Runs 1 to 3**, about five hours: one session per phase at `SCALE=1`
   ([The runs, in order](#the-runs-in-order) says what each should show). Volunteer check-in and
   redemptions bind no per-IP limit, so only runs 1 and 2 take them.

   ```bash
   limiter() {  # limiter "<note>" <phase>... -- <ladder option>...
     local note=$1 p phases=()
     shift
     while [[ $# -gt 0 && $1 != -- ]]; do phases+=("$1"); shift; done
     shift
     for p in "${phases[@]}"; do
       node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase "$p" --scales 1 \
         ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"} --note "$note" "$@"
     done
   }
   ALL=(checkin-volunteers checkin-participants redemptions raffle survey)
   BINDING=(checkin-participants raffle survey)

   limiter "run 1: single" "${ALL[@]}" -- --ip-mode single
   limiter "run 2: single, venue trusted" "${ALL[@]}" -- \
     --ip-mode single --env TRUSTED_IPS=203.0.113.10
   limiter "run 3: cgnat 70/10" "${BINDING[@]}" -- --ip-mode cgnat
   limiter "run 3: dry-run mix" "${BINDING[@]}" -- \
     --ip-mode cgnat --k6-env WIFI_SHARE=0.15 --k6-env CARRIER_IPS=5
   limiter "run 3: one dominant carrier" "${BINDING[@]}" -- \
     --ip-mode cgnat --k6-env WIFI_SHARE=0.15 --k6-env CARRIER_IPS=2
   ```

   Each rung prints `pass` or `FAIL` with its refused share and captchas. A failing rung in run 1 or
   3 is a finding and is recorded as one; a rung marked `INVALID`, or a session that stops, met a
   busy host, so run that line again. `TRUSTED_IPS` must match `VENUE_IP`, whose default is
   `203.0.113.10`. Keep the notes the same from one session to the next, so the rung lists read
   alike.

6. **Raffle capacity**, about 80 minutes. Setup checks in 500 × `SCALE` participants, a few minutes
   at the top rungs. Keep `docker stats` open: k6 should stay small at `SCALE=16` and 20, and no rung
   should fail on `rate_limited`, either of which would mean phones sharing sessions again. It ends
   by printing the capacity and the knee:

   ```bash
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase raffle --shedding off --find-knee \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"}
   ```

7. **Survey capacity**, about 60 minutes. Setup alone takes up to three minutes at `SCALE=20`:

   ```bash
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase survey --shedding off --find-knee \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"}
   ```

8. **Shedding past raffle's knee**, about 25 minutes. Put the knee from step 6 first, then 16 if the
   knee is below 16, then 20 if it is below 20. Another configuration is another session, with
   `--env` and a `--note` (run 5 above):

   ```bash
   node scripts/loadtest/ladder.ts --host "$LT_HOST" --phase raffle --scales <knee>,16,20 \
     ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"}
   ```

9. **Report and commit** on a branch of its own, in the clone:

   ```bash
   git switch -c "feature/loadtest-$LT_HOST-$(date +%F)"
   npm run loadtest:report
   git add loadtest/history docs/performance/load-test-results.md
   git commit -m "docs(loadtest): record the $LT_HOST load-test session"
   ```

10. **Push the branch**, then merge it into `develop` from wherever `develop` is merged, with
    `npm run check` after:

    ```bash
    git push origin "$(git branch --show-current)"   # in the clone, from step 9
    ```

    A clone on the development machine can merge locally instead, and drop the branch:

    ```bash
    branch=$(git branch --show-current)   # in the clone, from step 9
    cd <working checkout>
    git fetch <clone path> "$branch:$branch"
    git switch develop
    git merge --no-ff "$branch"
    npm run check
    git branch -d "$branch"
    ```

A session stopped by three invalid rungs keeps the rows it wrote; the last line names the busy
processes. Clear them and run the same command again: it starts a new session, and the report reads
both. Committing only docs between sessions leaves `app_tree` unchanged, so they still compare as one
version of the app.

### Running steps 3 to 8 in one go

`scripts/loadtest/session.sh` chains steps 3 to 8 and stops at the first one that fails. Step 9
onwards stays by hand.

Before starting, on the load-test host:

- **Start a tmux session**, so a dropped SSH connection does not kill the run, and log what it
  prints:

  ```bash
  tmux new -s loadtest bash          # Ctrl-b d detaches; tmux attach -t loadtest reattaches
  cd pelicanpass-loadtest
  tmux pipe-pane -o "cat >> $HOME/loadtest-$(date +%F).log"
  ```

- **Do steps 1 and 2** as usual: a clean tree, the clone updated, and `LT_HOST` and `LT_CPUSET`
  exported. The script reads them from its environment, so `export` them; the step 1 block sets
  shell variables only.
- **Check `PASS_BAND_ENABLED`** is not `false` in `.env` (`grep -n PASS_BAND .env`), or the band
  polls return 404.
- **Set a webhook** for progress messages, if wanted. Without one, the messages only print:

  ```bash
  read -rsp 'Webhook URL: ' LOADTEST_NOTIFY_WEBHOOK_URL && echo && export LOADTEST_NOTIFY_WEBHOOK_URL
  ```

  The variable is not `DISCORD_WEBHOOK_URL`. The script sources the event `.env`, which defines
  that one, so progress would go to the production alert channel.

Run it from the clone's root. It starts at step 3:

```bash
scripts/loadtest/session.sh
```

The optional argument is a step label, or a prefix of one. The labels, in order, are `3-rebuild`,
`4-smoke`, `5-run1`, `5-run2`, `5-run3-cgnat`, `5-run3-dry-run`, `5-run3-carrier`,
`6-raffle-capacity`, `7-survey-capacity` and `8-shedding`. To start elsewhere:

```bash
scripts/loadtest/session.sh 6                  # raffle capacity onwards
scripts/loadtest/session.sh 5-run3-dry-run     # run 3's dry-run mix onwards
KNEE=<n> scripts/loadtest/session.sh 8         # shedding alone, past a known knee
```

Each invocation writes a new log directory, so step 8 started on its own cannot read the knee from
step 6. Give it `KNEE`.

The script stops at the first failed step: a failed rebuild, a smoke threshold crossed, or a ladder
that met three invalid rungs. A `FAIL` rung is a finding, not a stop, and is counted in the step's
message. After a stop, run it again from the step that failed. Each step's output is in
`.ignore/session-<UTC timestamp>/<step>.log`.

Leave the host idle. During raffle capacity, watch `docker stats` in a second tmux window
(`Ctrl-b c`): k6 should stay small at `SCALE=16` and 20.

Then do step 9 onwards by hand. Re-run any line that came back `INVALID` first, then report and
commit.

### First session on a new host

Once per machine, before step 1. The report groups every table by host, so each machine's lines read
beside the others rather than mixing with them.

- **Clone from `origin`**: a clone, not a worktree, since the image build reads `.git`.

  ```bash
  git clone https://github.com/yorsh-co/pelicanpass.git pelicanpass-loadtest
  cd pelicanpass-loadtest && git switch develop && mkdir -p .ignore
  ```

- **Put the event's `.env` in place** by hand; it is never committed. The stack opens every date gate
  itself (landing, survey, closing), so the real event's dates work as they are.
- **Choose the label** for `LT_HOST` and keep it: a session under a different spelling reads as
  another machine.
- **Mind the memory.** Postgres here is tuned for an 8 GB host, and it is a second copy beside the
  event stack if that runs on the same machine.

## Reading a run

k6 exits non-zero if any threshold fails. The ones that matter:

| Metric                                            | Threshold                   | What a failure means                                                        |
| ------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `rate_limited`                                    | 0%                          | A person was refused. Its `name` tag says where                              |
| `captcha_required`                                | 0                           | The global failure budget tripped, or a session locked itself out            |
| `flow_failed`                                     | 0%                          | A person did not finish, and not because of a shed. The console line names the step and status |
| `server_errors`                                   | 0%                          | A 5xx other than a shed. Read the app log                                    |
| `served_duration`                                 | p95 < 500 ms, p99 < 1.5 s   | Too slow somewhere. Every measured request that was not shed, static files included |
| `shed` / `flow_shed`                              | none                        | Requests and flows the app turned away under load. Meant to rise above capacity |
| `checkin_complete_duration` / `survey_submit_duration` | p95 < 300 ms           | The phase's database transaction is queueing                                 |

While it runs, watch the host as well:

- `docker stats`: **the app is one Node process, so its ceiling is one core** however many the host
  has.
- `/admin/metrics` on the load-test stack, if reachable: each limiter's usage, live.
- Pool pressure:

  ```bash
  docker compose -f compose.loadtest.yml exec db psql -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" \
    -c "select state, wait_event_type, count(*) from pg_stat_activity group by 1, 2"
  ```

  The app's pool is 10 connections, with a 5 s acquire timeout (`src/shared/db/postgres.ts`).
- `free -h`: Postgres is tuned for an 8 GB host (`shared_buffers=2GB`), and this stack adds a
  second copy of it beside the event stack's.

If run 4 shows the app pinned at one core (above 70% at `SCALE=2`, or climbing latency with the pool
idle), more processes are the next step. That is a code change and not a setting, because
the WhatsApp runner's boot sweep, the alert rules and the in-memory telemetry window all assume one
process. Size it from the numbers, not before.

## How a session is recorded and judged

`scripts/loadtest/ladder.ts` runs one session: one phase, one configuration. It builds and restarts
the app once, so the image matches the working tree the rows record, then per rung resets the
database and Redis, samples the host while k6 runs, and appends one row to
`loadtest/history/<UTC date>T<HHMM>Z-<host>-<short sha>.csv`. One file per session, committed, so
branches never conflict on a shared file. `npm run loadtest:report` reads every file and writes
[`load-test-results.md`](./load-test-results.md); `npm run check` fails while it is stale. The raw
k6 summaries and per-second samples stay in the git-ignored `loadtest/results/` for diagnosing a
flagged rung.

The short SHAs in the file names and the `commit` column refer to the private archive repository,
not to this repository's history.

**Definitions.**

- **Capacity:** per phase, the highest `SCALE` that passes with shedding off. A pass is served p95
  under 500 ms and p99 under 1.5 s, `server_errors` and `flow_failed` at 0, and at most 1% of
  arrivals dropped. The **knee** is the first `SCALE` that fails.
- **Estimated users:** capacity × the population the phase models at `SCALE=1`: 500 participants
  for check-in, raffle and survey, 200 volunteers for volunteer check-in. The headline is the lowest
  estimate across phases, stated against a **baseline of 1,000 users** as headroom. `SCALE` itself
  never changes meaning, so every session stays comparable with the ones before it.
- **Best configuration:** among the shedding-on settings tried at one host and app version, the one
  that meets the target at every `SCALE` from the knee up with the lowest shed rate at the knee; if
  none does, the report names the closest, by the share of its rungs failing.
- **Server capacity, not venue capacity.** Capacity rungs give every phone its own address
  (`IP_MODE=spread`), so no limiter binds. What a venue behind one address gets through is runs 1 to
  3, compared under **Limiter balance**.

**What each row records**, besides the k6 results: the host (CPU, cores, RAM, kernel, WSL, Docker,
the cores the app was pinned to), the code, the shedding and limiter configuration as the running
container resolved it (`TRUSTED_IPS` only as set or unset), the load, and samples taken while k6
ran. The columns worth knowing:

- **`app_tree`** identifies the app a rung ran: a hash of `git ls-tree HEAD` over what goes into the
  image (`APP_PATHS` in `scripts/loadtest/history/code.ts`), with `git diff HEAD` over the same paths
  folded in. The report groups by it, not by commit, so a docs-only commit does not split one
  version of the app; two dirty runs group only when they carry the same change.
- **`harness_tree`** does the same for the scenarios (`loadtest/run.ts`, `loadtest/lib/`). Rows
  under different harness trees are reported apart, since a changed scenario changes what `SCALE`
  means.
- **`dirty`** means tracked files in the clone differed from `HEAD`, read from git on the host, not
  from the image's release string, which ignores `loadtest/`. An `npm ci` that rewrites
  `package-lock.json` makes a session dirty; restore the file before running.
- **`other_load_p95`** is the CPU of every process outside the stack and the runner, in cores,
  attributed per process from `/proc`; **`other_top`** names the biggest. **`throttle_ms`** is how
  long Intel's package counter says the CPU was held back for heat or power during the rung.
- **`shed_starts`** counts `Load shedding started` lines, and **`pool_waiting_at_start_max`** the
  largest pool queue on them. Since the October 2026 change to per-request shedding,
  `shed_starts` counts reporting episodes rather than flag flips, so compare the queue figure across
  that change instead.
- **`app_cpuset`**: on a hybrid Intel part the app is pinned to the performance cores
  (`--app-cpuset`, falling back to `taskset` under rootless Docker), so rungs do not depend on the
  scheduler's choice.

**A rung is invalid**, and kept in the file with its reason, when the host was busy (more than one
core of other load at p95), the CPU throttled for more than a second, more than 1% of arrivals were
dropped while the thresholds passed (it passed on less load than its `SCALE` says), or setup or k6
failed for any reason but thresholds. An invalid rung is retried, up to three runs of one `SCALE`;
a third stops the session with the reason.

**Finding the knee** (`--find-knee`): double from `SCALE=1` until the first failure, then bisect
until the last pass and the first fail are one step apart. The harness stops at `SCALE=20`, so a
phase passing there reports no knee up to 20, ten times the baseline. The rungs either side of the
knee run twice; if a repeat disagrees, the knee is marked unstable and the lower capacity is used.

**The report** has four sections: hosts; capacity per host and app version, with the event-wide
estimate; shedding past the knee, every configuration ranked with the best marked; and every rung
by session, invalid ones with their reasons. `--csv` writes every session as one CSV instead.

## Calibrating from the dry run

The dry run cannot load anything, but it gives facts the model guesses at:

- **Requests per person per flow.** Group the app's request log by session and path, and compare it
  with the 5 limited requests a check-in costs here.
- **The venue's public egress address**, for `TRUSTED_IPS`.
- **Roughly how many phones are on Wi-Fi rather than 4G**, which picks between `single` and `cgnat`
  as the realistic mode.

The teardown's traffic summary (`scripts/telemetry/traffic-summary.ts`, [`deployment.md`
§ Teardown](../operations/deployment.md#teardown)) answers the first and third from the request log without
keeping it: per-address peaks for each limiter, the IPv4 and IPv6 split, the biggest shares one
address carried, and entry failures a minute.

What the 2026-09-26 dry run (28 check-ins) gave. It predates the summary, and only the `warn`+ log
file was archived, so no successful request survived and the request counts above could not be
recovered:

- **Entry failures:** one attendee mistyped the ticket (twice) and three mistyped the verification
  code once. `TYPO_RATE` and `CODE_TYPO_RATE` default to those rates.
- **Addresses:** `req.ip` matched `CF-Connecting-IP` on every line, with one forwarded hop, so the
  per-IP limiters key on the phone's own address. Seven of the eight attendee-side addresses were
  distinct IPv6, one per phone, which no per-IP limiter binds on. Eight addresses from error lines
  only is a hint, not a measurement.

## Known gaps

- **Arrival shape is assumed.** The 3× burst and the front-loaded survey are guesses until the dry
  run says otherwise.
- **Browser caching is not modelled.** Static files are fetched on each check-in's two pages and
  never after; a real phone revalidates some of them later.
- **The admin surfaces are not loaded:** the metrics poll, attendee editor and WhatsApp sender. One
  or two operators use them, and their own session limiters bound them.
- **No client backs off.** The polls sleep a fixed `POLL_SECONDS`, and a shed flow is dropped rather
  than retried after `Retry-After`. That models phones that never back off, the worst case and the
  right one for tuning the shedding limits; a real phone only makes it gentler.
- **A shed is recognised by `503` plus `Retry-After`**, which only the load-shedding middleware
  sends. `http_req_duration` still includes sheds; read `served_duration` instead.

## What the numbers mean for an event

Capacity belongs to a host and a commit, not to the project. The figures below are the 2026 event's:
the host that served it, measured at the code it ran, beside the development laptop. Another
event's host, or a developer's own machine, measures its own with
[A full session, from scratch](#a-full-session-from-scratch), starting at
[First session on a new host](#first-session-on-a-new-host), and its rows join these in
[`load-test-results.md`](./load-test-results.md), which is the record whenever the two disagree.

**What `SCALE=1` is.** A room of 500 participants, the event's own size. Capacity is measured on the
two phases that load the server hardest, and **users** is `SCALE` × 500:

- **Raffle:** three draws, three minutes apart. After each, most of the room opens its pass within a
  minute to check the number, while every phone polls its pass front.
- **Survey:** 500 answers in five minutes, front-loaded on the announcement, while every phone polls.

**Why the raffle binds.** The app is one Node process, so its ceiling is one core. The post-draw
burst is app work: at the raffle's knee the app sits at 107–113% of a core while Postgres peaks
near 40%. The survey loads the database and the pool instead, and has no knee up to `SCALE=20` on
either host. Single-thread speed therefore sets capacity, more than core count or memory.

**Capacity and comfortable.** Capacity is the highest `SCALE` that passed every run, which is close
to the edge: served p95 climbs several-fold in the last step before the knee. The
comfortable figure is the step below, where latency is still flat, and it is the one to plan with.

### The 2026 event

Shedding off, `IP_MODE=spread`, harness at archive commits `78120e4` for `prod-server` and `a9309ee` for `dev-server`. Served p95 at the comfortable step.

| Host                     | Hardware                                                           | Raffle, comfortable  | Raffle, capacity | Knee | Survey                 | Measured   | Commit    |
| ------------------------ | ------------------------------------------------------------------ | -------------------- | ---------------- | ---- | ---------------------- | ---------- | --------- |
| `prod-server`, the event host | Xeon E3-1220 v5 (4 cores, 3.0–3.5 GHz), 8 GB single-channel, SATA SSD | 7: 3,500 users, 17 ms | 8: 4,000 users   | 9    | none up to 20: ≥ 10,000 | 2026-10-14 | `d02ad58` |
| `dev-server`, a dev laptop   | i7-1260P, app pinned to performance cores, 16 GB                    | 10: 5,000 users, 15 ms | 11: 5,500 users | 12   | none up to 20: ≥ 10,000 | 2026-09-30 | `650e5c3` |

The event host carries seven times its room comfortably on the hardest phase, on a 2015 four-core
server.

**Past the knee, shedding is what keeps it correct.** With shedding off, `prod-server` at `SCALE=16`
answered 11.0% of requests with a 5xx and 11.2% of flows failed. With the default limits on (lag
250 ms, pool 20), it served `SCALE=9`, 16 and 20 (up to 10,000 people) with no server errors and no
failed flows, at p95 258, 543 and 656 ms (p99 285, 686 and 976 ms), by refusing 2.6–26% of requests
with `503` and `Retry-After`
([`overload-behaviour.md`](./overload-behaviour.md#load-shedding)). The shedding target was met at
the knee and missed at 16 and 20, where served p95 exceeded its 500 ms threshold. Do not run an
event with `LOAD_SHED_ENABLED=false`.

**What these figures are not:**

- **Not venue capacity.** Capacity rungs give every phone its own address, so no limiter binds. A
  room behind one venue address gets through only with that address in `TRUSTED_IPS`, which runs 1
  to 3 measure, under **Limiter balance** in the report.
- **Not the whole path.** k6 calls `app:3000` directly, so the Cloudflare edge, the tunnel, Caddy and
  the host's uplink are untested. For the app the figures are a lower bound, since k6 shares the
  host (about one core of `prod-server`'s four at the raffle's knee); for the system as a whole they are
  an upper bound.
- **Not real phones.** [Known gaps](#known-gaps) lists what the scenarios assume.

### What the live event confirmed

It neither confirmed nor refuted the capacity figures. The room peaked at 17 check-ins in a minute
and 92 in 15, and no request was refused for load. But the test counts requests and the event counts
check-ins, and a check-in takes several requests. The event-day request log was lost, so the two
cannot be compared. See [`event-2026-10-17.md`](../reports/event-2026-10-17.md#capacity).

## Results

Sessions run through the ladder are in the generated [`load-test-results.md`](./load-test-results.md).
The session below was run by hand before the runner existed. It has no row history, and about half
of its rungs overlapped a desktop session on the host, so it is kept as the record behind the
shedding limits, not as a baseline to compare against.

### 2026-09-28: load-shedding tuning (runs 4 and 5)

dev-server (16 cores, 15 GiB), `IP_MODE=spread`, nothing else running (whole-host CPU at most 23%).
Served p95 / p99. `server_errors` and `flow_failed` were 0 on every rung.

**Raffle**, 500 participants. The knee is `SCALE=16`, and the limit is the app's one core: the
database stayed under 30% CPU.

| `SCALE` | Shedding off     | 1 s stop (`975d179`)                 | 5 s stop (`371ab1a`)                  |
| ------- | ---------------- | ------------------------------------ | ------------------------------------- |
| 10      | 28 / 41 ms       | 30 / 41 ms, nothing shed             | —                                     |
| 12      | 482 / 540 ms     | 323 / 370 ms, 3.5% shed, 4 starts    | 303 / 343 ms, 12.5% shed, 3 starts    |
| 16      | 3,980 / 5,377 ms | 585 / 663 ms, 27.3% shed, 31 starts  | 487 / 611 ms, 52.9% shed, 13 starts   |

Every start came from the pool queue, at 20–95 waiting when it tripped. Event-loop lag stayed at
20–60 ms, so these runs do not test `LOAD_SHED_MAX_LAG_MS`. Halving `LOAD_SHED_MAX_POOL_WAITING`
to 10, with the 1 s stop, gave 258 / 305 ms and 5.3% shed at `SCALE=12`, and 536 / 635 ms and
30.7% shed at 16.

**Survey**, 8,500 participants, so every submit is a first insert. 10–12 ms p95 from `SCALE=1`
to 16 with shedding off: no knee. At 16 with shedding on (5 s stop), nothing was shed.

**Chosen limits: the defaults stay** (`LOAD_SHED_MAX_LAG_MS=250`, `LOAD_SHED_MAX_POOL_WAITING=20`,
`LOAD_SHED_RETRY_AFTER_SECONDS=5`):

- Below the knee they do not shed: raffle at `SCALE=10` and survey at 16 match shedding off.
- At the knee, the threshold is not the lever. A pool limit of 10 took 49 ms off p95 and shed
  more. The switch timing is the lever. Stopping after one healthy second let the queue refill
  within two, about ten on/off cycles a draw; `SAMPLES_TO_STOP` now holds shedding for 5 s.
- The 5 s stop meets the target at the knee but sheds about twice as many requests. Shedding is
  all or nothing, and while it is on the pool queue reads empty, so the sampler cannot see how much
  demand is waiting. k6 overstates the cost, since its clients ignore `Retry-After`.
- Four or five on/off cycles a draw remain at `SCALE=16`, above the one-a-minute target. Shedding
  in proportion to the queue, rather than behind one flag, is the follow-up: step 5 of
  [`overload-behaviour.md`](./overload-behaviour.md#load-shedding).

## Tearing down

```bash
docker compose -f compose.loadtest.yml down -v
```

`-v` takes the synthetic roster, the Redis data and the load-test logs with it.
