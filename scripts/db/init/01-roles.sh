#!/bin/sh
#
# Provisions the least-privilege roles the application stack connects as.
#
# The `postgres` image runs everything in /docker-entrypoint-initdb.d once, on a
# freshly initialised data directory — that is the production path. Against a
# database that already exists (a development volume, or a host being upgraded
# into this scheme) run it by hand:
#
#   docker compose exec db sh /docker-entrypoint-initdb.d/01-roles.sh
#
# It is idempotent: roles are created only when absent, passwords are always
# reset so they track the environment, grants are naturally repeatable, and the
# ownership loop is a no-op once ownership is already correct.
#
# What it deliberately does NOT do: grant anything on `attendees`. Column-level
# grants need the table to exist, and initdb runs before the first migration.
# They live in migrations/005_app-role-grants.ts instead.

set -eu

# ---------------------------------------------------------------------------
# Input validation
#
# Role names and passwords are interpolated into SQL text by the shell, because
# psql's own :'var' substitution does not reach inside dollar-quoted blocks.
# Constraining both to identifier- and alphanumeric-safe characters is what
# makes that interpolation safe. The password rule is not arbitrary: the
# DATABASE_URL in `npm run migrate` is assembled by string interpolation too, so
# anything outside [A-Za-z0-9] breaks the migrator regardless.
# ---------------------------------------------------------------------------

require_role_name() {
  eval "value=\${$1:-}"
  case "$value" in
    '') echo "01-roles.sh: $1 is required" >&2; exit 1 ;;
  esac
  if ! echo "$value" | grep -Eq '^[a-z_][a-z0-9_]*$'; then
    echo "01-roles.sh: $1 must match ^[a-z_][a-z0-9_]*\$" >&2
    exit 1
  fi
}

require_password() {
  eval "value=\${$1:-}"
  case "$value" in
    '') echo "01-roles.sh: $1 is required" >&2; exit 1 ;;
  esac
  if ! echo "$value" | grep -Eq '^[A-Za-z0-9]{12,}$'; then
    echo "01-roles.sh: $1 must be at least 12 characters of [A-Za-z0-9] only" >&2
    exit 1
  fi
}

require_role_name APP_ROLE
require_role_name MIGRATOR_ROLE
require_role_name READONLY_ROLE

require_password APP_ROLE_PASSWORD
require_password MIGRATOR_ROLE_PASSWORD
require_password READONLY_ROLE_PASSWORD

# ---------------------------------------------------------------------------
# Provisioning
#
# `$$` is escaped throughout: an unescaped one would be expanded by the shell to
# its own PID before psql ever saw it.
# ---------------------------------------------------------------------------

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	-- Roles ------------------------------------------------------------------
	-- NOSUPERUSER is the finding: a superuser has COPY … FROM PROGRAM, which
	-- makes any SQL injection in the application remote code execution on this
	-- host. Nothing else in this file matters as much as that one attribute.

	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
	    CREATE ROLE ${APP_ROLE} LOGIN;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
	    CREATE ROLE ${MIGRATOR_ROLE} LOGIN;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READONLY_ROLE}') THEN
	    CREATE ROLE ${READONLY_ROLE} LOGIN;
	  END IF;
	END
	\$\$;

	ALTER ROLE ${APP_ROLE}
	  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
	  PASSWORD '${APP_ROLE_PASSWORD}';
	ALTER ROLE ${MIGRATOR_ROLE}
	  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
	  PASSWORD '${MIGRATOR_ROLE_PASSWORD}';
	ALTER ROLE ${READONLY_ROLE}
	  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
	  PASSWORD '${READONLY_ROLE_PASSWORD}';

	-- Database and schema access ----------------------------------------------
	-- Postgres 15+ already revokes CREATE on public from PUBLIC; USAGE is still
	-- granted to it. Revoking that too means a role added later starts with no
	-- visibility at all until it is granted some explicitly.

	GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO ${APP_ROLE}, ${MIGRATOR_ROLE}, ${READONLY_ROLE};

	REVOKE ALL ON SCHEMA public FROM PUBLIC;
	GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${READONLY_ROLE};
	GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR_ROLE};

	-- Extensions --------------------------------------------------------------
	-- Created here rather than by migration 002, which issues the same statement
	-- but runs as the migrator. pgcrypto is a trusted extension, so installing it
	-- needs CREATE on the *database* — a broader grant than CREATE on the schema,
	-- and one that would also let the migrator add schemas. Provisioning it with
	-- the superuser that already exists is cheaper than widening a role.
	--
	-- Migration 002 still works untouched: CREATE EXTENSION IF NOT EXISTS returns
	-- before its privilege check when the extension is already present.

	CREATE EXTENSION IF NOT EXISTS pgcrypto;

	-- Ownership ---------------------------------------------------------------
	-- The migrator has to own what it migrates, including node-pg-migrate's own
	-- pgmigrations bookkeeping table — without that it cannot record a single
	-- applied migration. A no-op on a fresh database, where nothing exists yet.

	DO \$\$
	DECLARE
	  obj record;
	BEGIN
	  FOR obj IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
	    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', obj.tablename, '${MIGRATOR_ROLE}');
	  END LOOP;

	  FOR obj IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
	    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', obj.sequencename, '${MIGRATOR_ROLE}');
	  END LOOP;
	END
	\$\$;

	-- Default privileges ------------------------------------------------------
	-- Anchored on the migrator because it is what creates every object.
	--
	-- Note what is absent: no table-level default for the application role.
	-- Grants are additive, so a table-wide GRANT SELECT cannot be narrowed by a
	-- column-level one — a default here would make the column grants in
	-- migration 005 decorative and hand the app full read access to the next
	-- table holding personal data the moment it is created. The intended
	-- failure mode is the opposite: a permission error the first time a new
	-- table is read, fixed by granting explicitly in that table's migration.

	ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};

	ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public
	  GRANT SELECT ON TABLES TO ${READONLY_ROLE};

	ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public
	  GRANT SELECT ON SEQUENCES TO ${READONLY_ROLE};

	-- Existing objects, for the read-only role only. The application role is
	-- granted per column in migration 005.

	GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READONLY_ROLE};
	GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${READONLY_ROLE};
EOSQL

echo "01-roles.sh: provisioned ${APP_ROLE}, ${MIGRATOR_ROLE}, ${READONLY_ROLE}"
