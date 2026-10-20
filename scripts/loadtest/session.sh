#!/usr/bin/env bash
#
# Runs steps 3 to 8 of a load-test session back to back: rebuild the stack,
# smoke every phase, runs 1 to 3, raffle capacity, survey capacity and shedding
# past the raffle knee. Step 9, the report and commit, is left to the operator.
# The procedure, and what to check before starting, is in
# docs/performance/load-testing.md § A full session, from scratch.
#
# Needs bash, Docker, Node 24, and curl and jq when the webhook is set.
#
# Configuration, from the environment:
#
#   LT_HOST                       host label the report groups rows under (required)
#   LT_CPUSET                     performance cores to pin the app to; leave empty
#                                 on a CPU without efficiency cores
#   LOADTEST_NOTIFY_WEBHOOK_URL   Discord webhook for progress messages. Optional:
#                                 messages are always printed. Not DISCORD_WEBHOOK_URL,
#                                 which the event .env defines and would replace
#   KNEE                          raffle knee for step 8 when step 6 did not run
#                                 in this session
#
# Each step's output goes to .ignore/session-<UTC timestamp>/<step>.log.
#
# Stops at the first step that exits non-zero: a failed rebuild, a smoke phase
# with a crossed threshold, or a ladder that met three invalid rungs. A FAIL
# rung is a finding, not a stop, and is counted in the step's message.
#
# Usage:  scripts/loadtest/session.sh [first step]
#
# The first step is a label or a prefix of one, matched in STEPS order:
# `6` starts at raffle capacity, `5-run3-dry-run` at run 3's dry-run mix.
# `KNEE=<n> scripts/loadtest/session.sh 8` runs shedding alone past a known knee.

# No -e: each step's status is checked, so a failure is reported before exit.
set -uo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.." || exit 1

FROM=${1:-3}
STEPS=(3-rebuild 4-smoke 5-run1 5-run2 5-run3-cgnat 5-run3-dry-run
  5-run3-carrier 6-raffle-capacity 7-survey-capacity 8-shedding)

for s in "${STEPS[@]}" ''; do
  [[ -z $s ]] && { echo "unknown step: $FROM (one of: ${STEPS[*]})" >&2; exit 2; }
  [[ $s == "$FROM"* ]] && break
done

: "${LT_HOST:?set LT_HOST}"
LT_CPUSET=${LT_CPUSET:-}
WEBHOOK=${LOADTEST_NOTIFY_WEBHOOK_URL:-}

if [[ -n $WEBHOOK ]]; then
  for tool in curl jq; do
    command -v "$tool" > /dev/null || { echo "$tool is required when LOADTEST_NOTIFY_WEBHOOK_URL is set" >&2; exit 1; }
  done
fi

set -a; . ./.env || exit 1; set +a

mkdir -p .ignore
LOGS=.ignore/session-$(date -u +%Y%m%dT%H%MZ)
mkdir -p "$LOGS"

# notify <message>: prints the message, and posts it when a webhook is set. A
# failed post is a warning, not a stop.
notify() {
  echo "notify: $1"
  [[ -n $WEBHOOK ]] || return 0
  jq -n --arg c "[$LT_HOST] $1" '{content: $c}' |
    curl -fsS --max-time 10 -H 'Content-Type: application/json' \
      -d @- "$WEBHOOK" > /dev/null ||
    echo "warning: Discord notification failed" >&2
}

started=

# due <label>: true from the first label matching FROM onwards.
due() { [[ -n $started || $1 == "$FROM"* ]] && started=1; }

trap 'notify ":octagonal_sign: Session interrupted"; exit 130' INT TERM

# step <label> <command…>: runs one step, logging to $LOGS/<label>.log.
step() {
  local label=$1 log="$LOGS/$1.log" fails
  shift
  due "$label" || return 0
  echo "=== $label ==="

  if ! "$@" 2>&1 | tee "$log"; then
    notify ":x: **$label** failed. Session stopped.
\`\`\`
$(tail -n 15 "$log" | cut -c1-180 | head -c 1700)
\`\`\`"
    exit 1
  fi

  fails=$(grep -c ': FAIL ' "$log")
  notify ":white_check_mark: **$label** done$( ((fails)) && echo ", $fails FAIL rung(s)")"
}

# rebuild: step 3. The importer takes at most 5,000 data rows, so the roster
# goes in as chunks, each behind the header row.
rebuild() {
  local f
  docker compose -f compose.loadtest.yml down -v &&
    docker compose -f compose.loadtest.yml up -d --build --wait &&
    docker compose -f compose.loadtest.yml --profile tools run --rm --build migrate &&
    node scripts/loadtest/roster.ts --participants 10400 > .ignore/loadtest-roster.csv &&
    head -1 .ignore/loadtest-roster.csv > .ignore/roster-header.csv &&
    rm -f .ignore/roster-part-* &&
    tail -n +2 .ignore/loadtest-roster.csv | split -l 5000 - .ignore/roster-part- ||
    return
  for f in .ignore/roster-part-*; do
    cat .ignore/roster-header.csv "$f" |
      docker compose -f compose.loadtest.yml --profile tools run --rm -T migrate \
        node scripts/db/import-attendees.ts || return
  done
}

smoke() {
  local p
  for p in checkin-volunteers checkin-participants redemptions raffle survey; do
    docker compose -f compose.loadtest.yml exec -T db psql \
      -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" -v event_id="$EVENT_ID" \
      < scripts/loadtest/prepare.sql > loadtest/fixtures.json || return
    docker compose -f compose.loadtest.yml exec -T cache \
      redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL || return
    docker compose -f compose.loadtest.yml --profile tools run --rm -T k6 run \
      -e PHASE="$p" -e SMOKE=true run.ts || return
  done
}

ladder() {
  node scripts/loadtest/ladder.ts --host "$LT_HOST" \
    ${LT_CPUSET:+--app-cpuset="$LT_CPUSET"} "$@"
}

limiter() { # limiter "<note>" <phase>... -- <ladder option>...
  local note=$1 p phases=()
  shift
  while [[ $# -gt 0 && $1 != -- ]]; do phases+=("$1"); shift; done
  shift
  for p in "${phases[@]}"; do
    ladder --phase "$p" --scales 1 --note "$note" "$@" || return
  done
}

ALL=(checkin-volunteers checkin-participants redemptions raffle survey)
BINDING=(checkin-participants raffle survey)

notify ":arrow_forward: Session started at $(git rev-parse --short HEAD) from step $FROM"

step 3-rebuild rebuild
step 4-smoke smoke
step 5-run1 limiter "run 1: single" "${ALL[@]}" -- --ip-mode single
step 5-run2 limiter "run 2: single, venue trusted" "${ALL[@]}" -- \
  --ip-mode single --env TRUSTED_IPS=203.0.113.10
step 5-run3-cgnat limiter "run 3: cgnat 70/10" "${BINDING[@]}" -- --ip-mode cgnat
step 5-run3-dry-run limiter "run 3: dry-run mix" "${BINDING[@]}" -- \
  --ip-mode cgnat --k6-env WIFI_SHARE=0.15 --k6-env CARRIER_IPS=5
step 5-run3-carrier limiter "run 3: one dominant carrier" "${BINDING[@]}" -- \
  --ip-mode cgnat --k6-env WIFI_SHARE=0.15 --k6-env CARRIER_IPS=2
if due 6-raffle-capacity; then
  step 6-raffle-capacity ladder --phase raffle --shedding off --find-knee
  notify ":bar_chart: $(grep 'capacity SCALE=' "$LOGS/6-raffle-capacity.log")"
fi
if due 7-survey-capacity; then
  step 7-survey-capacity ladder --phase survey --shedding off --find-knee
  notify ":bar_chart: $(grep 'capacity SCALE=' "$LOGS/7-survey-capacity.log")"
fi
if due 8-shedding; then
  knee=${KNEE:-$(grep -oE 'knee [0-9]+' "$LOGS/6-raffle-capacity.log" 2>/dev/null | awk '{print $2}')}

  if [[ -z $knee ]]; then
    notify ":warning: No raffle knee found, so step 8 was skipped. Run it by hand, or rerun with KNEE=<n> and step 8-shedding."
    exit 1
  fi

  scales=$knee
  ((knee < 16)) && scales+=,16
  ((knee < 20)) && scales+=,20
  step "8-shedding-$scales" ladder --phase raffle --scales "$scales"
fi

notify ":checkered_flag: Session finished. Logs in $LOGS. Next: step 9, report and commit."
