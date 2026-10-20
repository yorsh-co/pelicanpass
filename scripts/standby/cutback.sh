#!/usr/bin/env bash
#
# Hands production back from this standby host to the primary during a quiet
# window, in the only order that loses nothing:
#
#   1. stop the app here, so nothing writes after the snapshot
#   2. snapshot this host
#   3. copy it to the primary and restore it there, interactively
#   4. wait while the operator moves SITE_HOST back
#   5. restart the pull timer, so this host is a standby again
#
# Configuration, from ~/.config/pelicanpass-standby.env or the environment:
#
#   STANDBY_CUTBACK_SSH_HOST  full-shell ssh alias for the primary
#   STANDBY_REMOTE_DIR        the primary's production checkout
#
# Usage:  cutback.sh

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

confirm() {
  local answer
  printf '\n%s\n' "$1"
  read -r -p "Type $2 to continue: " answer || die 'aborted'
  [[ "${answer}" == "$2" ]] || die 'aborted'
}

local_release="$(image_release)" || die 'could not read RELEASE from the app image'
remote_release="$(ssh -n "${STANDBY_CUTBACK_SSH_HOST}" \
  "cd '${STANDBY_REMOTE_DIR}' && docker compose run --rm --no-deps -T --entrypoint cat app RELEASE 2>/dev/null")" ||
  die 'could not read RELEASE on the primary'
[[ "${local_release}" == "${remote_release}" ]] ||
  die "release mismatch: here ${local_release}, primary ${remote_release}"

confirm "Release ${local_release} on both hosts.
Step 1: stop the app here. The public hostname answers with an error until
step 4. Confirm the primary's app is stopped and its power and uplink are stable." STOP

docker compose stop app

umask 077
mkdir -p "${STANDBY_DIR}"
name="cutback-$(date -u +%Y%m%dT%H%M%SZ).tar"
snapshot="${STANDBY_DIR}/${name}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

echo 'Step 2: snapshotting this host…'
scripts/standby/snapshot.sh </dev/null >"${snapshot}"
verify_snapshot "${snapshot}" "${work}" || die "snapshot failed validation: ${snapshot}"
prune_old "${STANDBY_DIR}" 'cutback-*.tar' 3 "${snapshot}"

echo 'Step 3: copying to the primary…'
# The file name expands here on purpose; `~` is left to the primary's shell.
# shellcheck disable=SC2029
ssh "${STANDBY_CUTBACK_SSH_HOST}" \
  "umask 077 && mkdir -p ~/standby && cat > ~/standby/${name}" <"${snapshot}"

# -t: restore.sh asks for its own typed confirmation on the primary.
ssh -t "${STANDBY_CUTBACK_SSH_HOST}" \
  "cd '${STANDBY_REMOTE_DIR}' && scripts/standby/restore.sh ~/standby/${name} --reserve 0 --cutback" ||
  die "restore on the primary failed; this host's app is stopped — restart it with
  docker compose start app   and leave SITE_HOST on this host's tunnel"

confirm 'Step 4: in the Cloudflare dashboard, move the public hostname (SITE_HOST) from
this host'"'"'s tunnel back to the production tunnel (docs/operations/fallback.md §4). Then confirm the
public /healthz and one real pass on a phone.' DONE

systemctl --user start pelicanpass-standby-pull.timer
echo 'Step 5: pelicanpass-standby-pull.timer restarted. This host is a standby again.'
