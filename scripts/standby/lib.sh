# shellcheck shell=bash
# Shared helpers for the standby scripts. Sourced, never executed.
#
# Every caller has already `cd`-ed into a production checkout, so `.env` and a
# bare `docker compose` both resolve to that host's production stack.

# Kept in step with the images compose.prod.yml runs: a snapshot is validated
# by the same pg_restore and redis-check-rdb that will later load it.
readonly STANDBY_PG_IMAGE='postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
readonly STANDBY_REDIS_IMAGE='redis:8.10.2@sha256:c94085d298b738be22c9ccdc0ac3761fa6649df7dd82ad1d42367f3cb9714935'

# The three members every snapshot carries, in archive order.
readonly STANDBY_MEMBERS=(meta db.dump cache.rdb)

die() {
  printf '%s: %s\n' "${0##*/}" "$*" >&2
  exit 1
}

# Prints one value from ./.env without sourcing it. The file is compose's, not
# a shell script, and sourcing it would execute whatever a value happens to
# contain.
#
# $1 - variable name
env_value() {
  local value
  value="$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-)" || return 1
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "${value}"
}

# Prints the release stamped into the built app image, as /readyz reports it.
# Read from the service's image in a one-off container, so it answers while
# `app` is stopped — which is exactly when a restore runs.
# `docker compose config --images` cannot be narrowed to one service.
#
# Docker calls here read from /dev/null: given the caller's stdin they consume
# it, and the confirmation prompt that follows reads EOF.
image_release() {
  docker compose run --rm --no-deps -T --entrypoint cat app RELEASE </dev/null 2>/dev/null
}

# Prints one key from an extracted snapshot's meta file.
#
# $1 - meta file
# $2 - key
meta_value() {
  grep -E "^$2=" "$1" | cut -d= -f2-
}

# Prints the largest snapshot, in bytes, that this host will accept from the
# primary: STANDBY_MAX_SNAPSHOT_BYTES, or 256 MiB when it is unset. Read here
# rather than fixed at the top of this file, because pull.sh sources its
# configuration after this file. A snapshot of an event this size is far
# smaller than the default; the cap only bounds a faulty or hostile primary.
snapshot_max_bytes() {
  local max="${STANDBY_MAX_SNAPSHOT_BYTES:-268435456}"
  [[ "${max}" =~ ^[1-9][0-9]*$ ]] ||
    { echo "STANDBY_MAX_SNAPSHOT_BYTES must be a positive integer, got '${max}'" >&2; return 1; }
  printf '%s' "${max}"
}

# Copies stdin to a file, reading at most one byte past the limit so a primary
# that never stops cannot fill the disk. Fails when the input is larger than
# the limit; the file then holds a truncated copy that the caller discards.
#
# $1 - largest accepted size, in bytes
# $2 - file to write
receive_capped() {
  local max="$1" dest="$2" size
  head -c "$((max + 1))" >"${dest}" || return 1
  size="$(stat -c %s "${dest}")" || return 1
  ((size <= max)) ||
    { echo "snapshot is larger than ${max} bytes" >&2; return 1; }
}

# Refuses a snapshot tar that is not exactly STANDBY_MEMBERS, each a regular
# file, with the members' sizes totalling no more than the limit. Reads the
# listing only; nothing is extracted. A sparse member is small in the tar and
# large on disk, which is why the member sizes are summed as well as the tar's.
#
# $1 - snapshot tar
# $2 - largest accepted size, in bytes
check_snapshot_members() {
  local tar="$1" max="$2" tar_size mode owner size date time name total=0 count=0

  tar_size="$(stat -c %s "${tar}")" || return 1
  ((tar_size <= max)) ||
    { echo "snapshot is larger than ${max} bytes" >&2; return 1; }

  while read -r mode owner size date time name; do
    [[ "${mode}" == -* ]] ||
      { echo "snapshot member is not a regular file: ${name}" >&2; return 1; }
    [[ "${name}" == "${STANDBY_MEMBERS[count]:-}" ]] ||
      { echo "snapshot has an unexpected member: ${name}" >&2; return 1; }
    count=$((count + 1))
    total=$((total + size))
  done < <(tar --list --verbose --numeric-owner -f "${tar}" 2>/dev/null)

  ((count == ${#STANDBY_MEMBERS[@]})) ||
    { echo "snapshot does not hold exactly the members, in order: ${STANDBY_MEMBERS[*]}" >&2; return 1; }
  ((total <= max)) ||
    { echo "snapshot members total ${total} bytes, over ${max}" >&2; return 1; }
}

# Checks a snapshot's members and size, extracts it into a directory and proves
# both dumps load: pg_restore can read the archive's table of contents and
# redis-check-rdb accepts the RDB. A snapshot that fails here is never kept and
# never restored.
#
# $1 - snapshot tar
# $2 - empty directory to extract into
verify_snapshot() {
  local tar="$1" dir="$2" max

  max="$(snapshot_max_bytes)" || return 1
  check_snapshot_members "${tar}" "${max}" || return 1

  tar -C "${dir}" -xf "${tar}" "${STANDBY_MEMBERS[@]}" ||
    { echo 'snapshot is not a complete archive' >&2; return 1; }

  [[ -n "$(meta_value "${dir}/meta" taken_at)" ]] ||
    { echo 'snapshot meta has no taken_at' >&2; return 1; }

  # --entrypoint: both images' entrypoints rewrite or wrap the command.
  docker run --rm --network none -v "${dir}:/s:ro" \
    --entrypoint pg_restore "${STANDBY_PG_IMAGE}" --list /s/db.dump </dev/null >/dev/null ||
    { echo 'db.dump failed pg_restore --list' >&2; return 1; }

  docker run --rm --network none -v "${dir}:/s:ro" \
    --entrypoint redis-check-rdb "${STANDBY_REDIS_IMAGE}" /s/cache.rdb </dev/null >/dev/null ||
    { echo 'cache.rdb failed redis-check-rdb' >&2; return 1; }
}

# Deletes all but the newest files in a directory that match a name pattern.
# The stamped names sort oldest first, so "newest" is the last by name. Only
# regular files directly inside the directory are considered: symlinks and
# subdirectories are never followed or removed. Each removal is logged.
#
# $1 - directory
# $2 - file name pattern, such as 'cutback-*.tar'
# $3 - how many of the newest files to keep
# $4 - file just written; never removed, and counted among those kept
prune_old() {
  local dir="$1" pattern="$2" keep="$3" current="$4" file seen=0

  while IFS= read -r -d '' file; do
    seen=$((seen + 1))
    [[ "${file}" -ef "${current}" ]] && continue
    ((seen > keep)) || continue
    if rm -f -- "${file}"; then
      echo "Pruned old file: ${file}"
    else
      echo "could not remove ${file}" >&2
    fi
  done < <(find "${dir}" -maxdepth 1 -type f -name "${pattern}" -print0 | sort -rz)
}
