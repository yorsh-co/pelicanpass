#!/usr/bin/env bash
#
# Replays the failover gap onto this host: the check-ins and redemptions the
# primary (prod-server) recorded after the snapshot this host restored, which never
# reached it. Run it on dev-server after prod-server comes back (docs/operations/standby.md §6),
# once prod-server's app is stopped.
#
# What was restored comes from STANDBY_DIR/last-restore.meta, written by
# restore.sh: snapshots/latest moves on once the pull timer restarts. The gap
# is extracted by gap-extract.sql, run read-only on prod-server, and held in memory
# only: it can contain personal data. It is replayed by replay-gap.ts in the
# `migrate` container, which must contain that file, so rebuild the image after
# pulling:
#
#   docker compose --profile tools build migrate
#
# Refuses when the last restore was made on this host (a cut-back, not a
# failover), and when prod-server's app is still running.
#
# Configuration, from ~/.config/pelicanpass-standby.env or the environment:
#
#   STANDBY_CUTBACK_SSH_HOST  full-shell ssh alias for the primary
#   STANDBY_REMOTE_DIR        the primary's production checkout
#
#   --dry-run       replay everything and roll back; writes nothing
#   --since TIME    ISO 8601 timestamp that replaces the restored snapshot's
#                   taken_at as the start of the gap
#
# Usage:  recover-gap.sh [--dry-run] [--since TIME]

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.."
# shellcheck source=scripts/standby/lib.sh
source scripts/standby/lib.sh

config="${HOME}/.config/pelicanpass-standby.env"
if [[ -f "${config}" ]]; then
  # shellcheck disable=SC1090
  source "${config}"
fi

: "${STANDBY_CUTBACK_SSH_HOST:?the primary full-shell ssh alias - see docs/operations/standby.md}"
: "${STANDBY_REMOTE_DIR:?the primary production checkout - see docs/operations/standby.md}"
readonly STANDBY_DIR="${STANDBY_DIR:-${HOME}/standby}"

# The shape gap-input.ts accepts. Also keeps the value safe to place in the
# remote command line.
readonly ISO_TIMESTAMP='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'

usage() { die 'usage: recover-gap.sh [--dry-run] [--since TIME]'; }

confirm() {
  local answer
  printf '\n%s\n' "$1"
  read -r -p "Type $2 to continue: " answer || die 'aborted'
  [[ "${answer}" == "$2" ]] || die 'aborted'
}

dry_run=false
since=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --since)
      [[ "${2:-}" =~ ${ISO_TIMESTAMP} ]] || usage
      since="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

meta="${STANDBY_DIR}/last-restore.meta"
[[ -f "${meta}" ]] ||
  die "no ${meta}: restore.sh writes it, so this host has not restored a snapshot"

taken_at="$(meta_value "${meta}" taken_at)"
checkin_number_last="$(meta_value "${meta}" checkin_number_last)"
reserve="$(meta_value "${meta}" reserve)"
restored_host="$(meta_value "${meta}" host)"

[[ "${checkin_number_last}" =~ ^[0-9]+$ && "${reserve}" =~ ^[0-9]+$ ]] ||
  die "${meta} has no valid checkin_number_last and reserve"
[[ -z "${since}" ]] || taken_at="${since}"
[[ "${taken_at}" =~ ${ISO_TIMESTAMP} ]] || die "${meta} has no valid taken_at"

this_host="$(env_value SERVER_NAME || true)"
this_host="${this_host:-$(hostname)}"
[[ "${restored_host}" != "${this_host}" ]] ||
  die "the last restore was a snapshot of ${this_host} itself (a cut-back), not a failover: there is no gap to recover"

event_id="$(env_value EVENT_ID || true)"
[[ "${event_id}" =~ ^[A-Za-z0-9._-]+$ ]] || die 'EVENT_ID in .env is missing or has unexpected characters'

floor=$((checkin_number_last + reserve))

# One command string, run by the remote shell. Single-quoted parts reach it
# literally; ${...} parts expand here and were validated above.
remote_dir="${STANDBY_REMOTE_DIR//\'/}"
running="$(ssh -n "${STANDBY_CUTBACK_SSH_HOST}" \
  "cd '${remote_dir}' && docker compose ps --status running --services")" ||
  die 'could not list the primary'"'"'s running services'
if grep -qx app <<<"${running}"; then
  die "the primary's app is still running and would keep writing; stop it first (docs/operations/standby.md §6):
  ssh ${STANDBY_CUTBACK_SSH_HOST} \"cd '${remote_dir}' && docker compose stop app\""
fi

echo 'Extracting the gap from the primary…'
psql_cmd='psql -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB" -X -q -t -A -v ON_ERROR_STOP=1'
gap="$(ssh "${STANDBY_CUTBACK_SSH_HOST}" \
  "cd '${remote_dir}' && docker compose exec -T db sh -c '${psql_cmd} -v t=${taken_at} -v e=${event_id}'" \
  <scripts/standby/gap-extract.sql)" ||
  die 'could not extract the gap from the primary'
[[ -n "${gap}" ]] || die 'the primary returned no gap'

mode='for real'
[[ "${dry_run}" == true ]] && mode='dry run'
echo "Gap since ${taken_at}, check-in number floor ${floor} (${mode})."

if [[ "${dry_run}" == false ]]; then
  confirm 'This WRITES the gap into the database of the stack in '"$(pwd)"'.
Run with --dry-run first if you have not.' REPLAY
fi

args=(--number-floor "${floor}")
[[ "${dry_run}" == true ]] && args+=(--dry-run)

# -T: the gap arrives on stdin. Never written to disk.
printf '%s' "${gap}" |
  docker compose run --rm -T migrate node scripts/standby/replay-gap.ts "${args[@]}"
