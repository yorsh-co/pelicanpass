#!/usr/bin/env bash
#
# Writes a snapshot of this host's production Postgres and Redis to stdout, as
# one tar holding:
#
#   meta       taken_at, host, release, checkin_number_last
#   db.dump    pg_dump custom format, as the migrator role
#   cache.rdb  a point-in-time RDB of the session store
#
# Read-only against the stack: nothing is stopped and nothing is written
# outside a temporary directory. Runs on whichever host is primary — on prod-server
# through the forced-command key that pull.sh uses, and on dev-server at cut-back.
#
# The tar holds every attendee's phone number in plaintext. See
# docs/operations/standby.md § Data retention.
#
# Usage:  snapshot.sh > snapshot.tar

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/../.."
# shellcheck source=scripts/standby/lib.sh
source scripts/standby/lib.sh

umask 077
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

[[ -t 1 ]] && die 'refusing to write a snapshot to a terminal; redirect stdout'

redis_password="$(env_value REDIS_PASSWORD)"
[[ -n "${redis_password}" ]] || die 'REDIS_PASSWORD is not set in .env'

# The db container's own MIGRATOR_ROLE and POSTGRES_DB, over its local socket,
# the same way the teardown export in deployment.md runs.
docker compose exec -T db sh -c \
  'pg_dump -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB" -Fc' >"${work}/db.dump"

checkin_number_last="$(docker compose exec -T db sh -c \
  'psql -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB" -tAc "SELECT last_value FROM checkin_number_seq"')"

# `--rdb` asks the server for a replication-style RDB, so the snapshot never
# depends on the server's own save schedule. The cache container has no
# password in its environment; REDISCLI_AUTH keeps it out of redis-cli's argv.
# `-` streams it to stdout, because the cache's root filesystem is read-only.
docker compose exec -T -e REDISCLI_AUTH="${redis_password}" cache \
  redis-cli --no-auth-warning --rdb - >"${work}/cache.rdb"

release="$(image_release)"
[[ -n "${release}" ]] || die 'could not read RELEASE from the app image'
host="$(env_value SERVER_NAME || true)"

{
  printf 'taken_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'host=%s\n' "${host:-$(hostname)}"
  printf 'release=%s\n' "${release}"
  printf 'checkin_number_last=%s\n' "${checkin_number_last}"
} >"${work}/meta"

tar -C "${work}" -cf - "${STANDBY_MEMBERS[@]}"
