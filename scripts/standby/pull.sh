#!/usr/bin/env bash
#
# Pulls one snapshot from the primary over SSH, validates it, and keeps it as
# STANDBY_DIR/snapshots/<UTC>.tar with `latest` pointing at it. Run every
# minute on the standby host by pelicanpass-standby-pull.timer.
#
# A failed pull leaves `latest` untouched, so the newest good snapshot is always
# what restore.sh finds. Two failures in a row raise a desktop notification:
# a stale snapshot is the first sign that the primary has gone.
#
# Configuration, from the environment (the unit reads
# ~/.config/pelicanpass-standby.env):
#
#   STANDBY_SSH_HOST  ssh alias for the primary's forced-command snapshot key
#   STANDBY_DIR       where snapshots live (default ~/standby)
#   STANDBY_KEEP      snapshots kept (default 30)
#   STANDBY_MAX_SNAPSHOT_BYTES
#                     largest snapshot accepted (default 268435456, 256 MiB)
#
# Usage:  pull.sh

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.."
# shellcheck source=scripts/standby/lib.sh
source scripts/standby/lib.sh

# Read here as well as by the unit, so a manual pull during a failover sees the
# same configuration as the timer's.
config="${HOME}/.config/pelicanpass-standby.env"
if [[ -f "${config}" ]]; then
  # shellcheck disable=SC1090
  source "${config}"
fi

: "${STANDBY_SSH_HOST:?the primary snapshot ssh alias - see docs/operations/standby.md}"
readonly STANDBY_DIR="${STANDBY_DIR:-${HOME}/standby}"
readonly STANDBY_KEEP="${STANDBY_KEEP:-30}"
readonly SNAPSHOTS="${STANDBY_DIR}/snapshots"
readonly FAILURES="${STANDBY_DIR}/.pull-failures"

umask 077
mkdir -p "${SNAPSHOTS}"

# A manual pull during a failover must not interleave with the timer's.
exec 9>"${STANDBY_DIR}/.pull.lock"
flock -n 9 || die 'another pull is running'

incoming="$(mktemp "${SNAPSHOTS}/.incoming.XXXXXX")"
work="$(mktemp -d)"
trap 'rm -rf "${incoming}" "${work}"' EXIT

notify() {
  command -v notify-send >/dev/null &&
    notify-send -u "$1" -a pelicanpass-standby "$2" "$3" || true
}

record_failure() {
  local count=0 since
  [[ -f "${FAILURES}" ]] && read -r count since <"${FAILURES}"
  count=$((count + 1))
  since="${since:-$(date +%H:%M)}"
  printf '%s %s\n' "${count}" "${since}" >"${FAILURES}"

  # On the second failure, then every ten minutes, rather than every minute
  # for as long as the primary is away.
  if ((count == 2 || (count > 2 && count % 10 == 0))); then
    notify critical 'Standby snapshot failing' \
      "No snapshot from ${STANDBY_SSH_HOST} since ${since} (${count} attempts)."
  fi
  die "pull failed (${count} in a row since ${since})"
}

max="$(snapshot_max_bytes)" || exit 1

# The forced command on the primary ignores whatever command is sent; naming
# none keeps it obvious that the key can run nothing else. `receive_capped` stops
# reading at the limit, so a stream that never ends cannot fill the disk; ssh
# may die of SIGPIPE then, and under pipefail that fails the pull as well.
ssh -n -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=3 "${STANDBY_SSH_HOST}" |
  receive_capped "${max}" "${incoming}" ||
  record_failure

verify_snapshot "${incoming}" "${work}" || record_failure

name="$(date -u +%Y%m%dT%H%M%SZ).tar"
mv "${incoming}" "${SNAPSHOTS}/${name}"
ln -sfn "${name}" "${SNAPSHOTS}/.latest.tmp"
mv -T "${SNAPSHOTS}/.latest.tmp" "${SNAPSHOTS}/latest"

if [[ -f "${FAILURES}" ]]; then
  rm -f "${FAILURES}"
  notify normal 'Standby snapshot recovered' "Pulling from ${STANDBY_SSH_HOST} again."
fi

find "${SNAPSHOTS}" -maxdepth 1 -name '*.tar' -printf '%f\n' | sort |
  head -n "-${STANDBY_KEEP}" | sed "s|^|${SNAPSHOTS}/|" | xargs -r rm -f --

printf 'kept %s (taken_at %s, checkin_number_last %s)\n' "${name}" \
  "$(meta_value "${work}/meta" taken_at)" \
  "$(meta_value "${work}/meta" checkin_number_last)"
