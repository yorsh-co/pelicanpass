#!/usr/bin/env bash
#
# Replaces this host's production Postgres and Redis with a snapshot from
# snapshot.sh, then starts the stack and waits for /readyz.
#
# Runs on whichever host is taking over: dev-server at failover, prod-server at
# cut-back. The current database is dumped to
# STANDBY_DIR/pre-restore-<UTC>.dump first, so whatever this host held that
# the snapshot does not — check-ins prod-server took after dev-server's last pull — is
# never lost to the restore.
#
#   --reserve N  advance checkin_number_seq by N after the restore (default
#                500). Numbers the old primary issued after the snapshot are
#                then never issued again here. Pass 0 at cut-back, where
#                writes were frozen before the snapshot was taken.
#   --cutback    end by handing back to cutback.sh, instead of naming the
#                failover's next step: the hostname moves the other way there.
#
# Records what it restored in STANDBY_DIR/last-restore.meta: the snapshot's
# meta plus reserve and restored_at. recover-gap.sh reads it, because
# snapshots/latest moves on once the pull timer restarts.
#
# Reads ~/.config/pelicanpass-standby.env when present, so a raised
# STANDBY_MAX_SNAPSHOT_BYTES applies here as it does to the pull.
#
# Usage:  restore.sh SNAPSHOT.tar [--reserve N] [--cutback]

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.."
# shellcheck source=scripts/standby/lib.sh
source scripts/standby/lib.sh

config="${HOME}/.config/pelicanpass-standby.env"
if [[ -f "${config}" ]]; then
  # shellcheck disable=SC1090
  source "${config}"
fi

readonly STANDBY_DIR="${STANDBY_DIR:-${HOME}/standby}"

usage() { die 'usage: restore.sh SNAPSHOT.tar [--reserve N] [--cutback]'; }

[[ $# -ge 1 ]] || usage
snapshot="$1"
shift
reserve=500
cutback=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reserve)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || usage
      reserve="$2"
      shift 2
      ;;
    --cutback)
      cutback=true
      shift
      ;;
    *) usage ;;
  esac
done
[[ -f "${snapshot}" ]] || die "no snapshot at ${snapshot}"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

redis_password="$(env_value REDIS_PASSWORD)"
[[ -n "${redis_password}" ]] || die 'REDIS_PASSWORD is not set in .env'

echo 'Validating snapshot…'
verify_snapshot "${snapshot}" "${work}" || die 'snapshot failed validation'

meta="${work}/meta"
taken_at="$(meta_value "${meta}" taken_at)"
snapshot_release="$(meta_value "${meta}" release)"
local_release="$(image_release)" || die 'could not read RELEASE from the app image'
age=$(($(date +%s) - $(date -d "${taken_at}" +%s)))

cat <<EOF

  Snapshot             ${snapshot}
  Taken                ${taken_at} on $(meta_value "${meta}" host), $((age / 60))m $((age % 60))s ago
  Release              ${snapshot_release} (this host: ${local_release})
  Last check-in #      $(meta_value "${meta}" checkin_number_last), next issued after +${reserve}

  This REPLACES the database and session store of the stack in $(pwd).

EOF

[[ "${snapshot_release}" == "${local_release}" ]] ||
  die 'release mismatch: check out and build the same tag on both hosts first'

read -r -p 'Type RESTORE to continue: ' answer || die 'aborted'
[[ "${answer}" == 'RESTORE' ]] || die 'aborted'

# Freezes the last pre-failover snapshot for reconciliation. Present only on
# the standby host.
if systemctl --user is-active --quiet pelicanpass-standby-pull.timer 2>/dev/null; then
  systemctl --user stop pelicanpass-standby-pull.timer
  echo 'Stopped pelicanpass-standby-pull.timer.'
fi

docker compose stop app
docker compose up -d db cache

echo 'Waiting for Postgres…'
for _ in $(seq 60); do
  docker compose exec -T db sh -c 'pg_isready -q -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB"' && break
  sleep 1
done

mkdir -p "${STANDBY_DIR}"
safety="${STANDBY_DIR}/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db sh -c \
  'pg_dump -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB" -Fc' >"${safety}"
echo "Safety dump of the previous database: ${safety}"
prune_old "${STANDBY_DIR}" 'pre-restore-*.dump' 3 "${safety}"
# At cut-back this host is the primary, and the tars cutback.sh copied here
# are its to prune.
prune_old "${STANDBY_DIR}" 'cutback-*.tar' 3 "${snapshot}"

echo 'Restoring Postgres…'
# One transaction: a restore that fails part-way leaves the previous database
# exactly as it was.
#
# Extension entries are dropped from the archive's list. The superuser owns
# pgcrypto, so the migrator cannot drop and recreate it; the target's own
# migrations already installed it.
docker compose exec -T db sh -c '
  cat >/tmp/standby.dump &&
    pg_restore -l /tmp/standby.dump | grep -v " EXTENSION " >/tmp/standby.list &&
    pg_restore -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB" -L /tmp/standby.list \
      --clean --if-exists --single-transaction --exit-on-error /tmp/standby.dump
  status=$?
  rm -f /tmp/standby.dump /tmp/standby.list
  exit "$status"' <"${work}/db.dump"

if ((reserve > 0)); then
  docker compose exec -T db sh -c "psql -v ON_ERROR_STOP=1 -U \"\$MIGRATOR_ROLE\" -d \"\$POSTGRES_DB\" -tAc \
    \"SELECT 'checkin_number_seq now ' || setval('checkin_number_seq', last_value + ${reserve}) FROM checkin_number_seq\""
fi

echo 'Restoring Redis…'
# Stopped first: Redis writes its own RDB on shutdown, which would otherwise
# overwrite the one copied in. Written by a one-off cache container, so it is
# owned by the `redis` user the service runs as; `docker compose cp` would keep
# this host's uid and mode 0600, which Redis cannot read. The rename replaces a
# dump.rdb of any owner, since /data itself belongs to `redis`.
docker compose stop cache
docker compose run --rm --no-deps -T --entrypoint sh cache -c \
  'cat >/data/.restore.rdb && mv -f /data/.restore.rdb /data/dump.rdb' \
  <"${work}/cache.rdb"
docker compose start cache

keys=''
for _ in $(seq 30); do
  keys="$(docker compose exec -T -e REDISCLI_AUTH="${redis_password}" cache \
    redis-cli --no-auth-warning DBSIZE 2>/dev/null)" && [[ "${keys}" =~ ^[0-9]+$ ]] && break
  keys=''
  sleep 1
done
[[ -n "${keys}" ]] || die 'Redis did not come back after the restore'
echo "Redis holds ${keys} keys."

# Atomic, so recover-gap.sh never reads a half-written record.
{
  cat "${meta}"
  printf 'reserve=%s\n' "${reserve}"
  printf 'restored_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"${STANDBY_DIR}/last-restore.meta.tmp"
mv -f "${STANDBY_DIR}/last-restore.meta.tmp" "${STANDBY_DIR}/last-restore.meta"

echo 'Starting the stack…'
docker compose up -d

# /readyz answers 404 without the header Caddy sets on the tailnet vhost.
for _ in $(seq 90); do
  if docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/readyz', { headers: { 'X-Admin-Gate': 'tailnet' } }).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))" \
    2>/dev/null; then
    echo
    if [[ "${cutback}" == true ]]; then
      echo 'Ready. cutback.sh continues with step 4 on the standby host.'
    else
      echo 'Ready. Next, in the Cloudflare dashboard: move the public hostname (SITE_HOST)'
      echo 'from the production tunnel to this host'"'"'s tunnel — docs/operations/standby.md §5.'
    fi
    exit 0
  fi
  sleep 1
done

die 'the app did not report ready within 90 s; check docker compose logs app'
