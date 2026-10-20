-- Redacts attendee phone numbers, leaving the rest of the record intact.
--
-- **Not a scheduled job.** This once ran 30 days after the event, back when the
-- host outlived the event by a month. It does not: teardown is roughly 24 hours
-- later and `docker compose down -v` is the retention policy, so there is no
-- calendar entry and no server left to run one on. See docs/security/data-retention.md
-- for the policy and docs/operations/deployment.md for the runbook.
--
-- Two moments call for it now, and both are decisions somebody makes:
--
--   1. Before a `pg_dump` that has to be kept. A dump holds every phone number
--      in plaintext and outlives the host that was the whole policy. Running
--      this first is what makes keeping one defensible.
--   2. An erasure request arriving before the event, against one row rather
--      than the whole table — see the deletion section in docs/security/data-retention.md.
--
-- Deliberately NOT a migration. `node-pg-migrate up` runs every pending
-- migration, so a purge living in migrations/ would fire the next time anyone
-- migrated for an unrelated schema change - plausibly during the event. As SQL
-- run by hand it only ever runs when someone means it.
--
-- The privilege boundary reinforces that: 005_app-role-grants grants the
-- application role UPDATE on the check-in columns only, so `pelicanpass_app`
-- cannot run this. It is a migrator-role act by construction.
--
-- Phone numbers only. Names survive this script - they belong to the wider
-- redaction in purge-attendees.sql, which runs when the event record itself is
-- retired. Whoever runs the narrow job must not destroy names as a side effect.
--
-- Usage, from the repo root:
--
--   set -a; . ./.env; set +a
--   docker compose exec -T db psql \
--     -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
--     -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
--     < scripts/db/purge-phone.sql
--
-- Take a backup first. This is not reversible.

\set ON_ERROR_STOP on

BEGIN;

-- Scoped to one event: a stack serves one event, but the table is not
-- guaranteed to hold only one, and an unscoped UPDATE here is unrecoverable.
UPDATE attendees
SET attendee_phone = '',
    updated_at = now()
WHERE event_id = :'event_id'
  AND attendee_phone <> '';

-- Reports its own result rather than leaving the operator to check. Expect
-- phones_remaining = 0; anything else means rows were missed, most likely a
-- mistyped event_id.
SELECT count(*) FILTER (WHERE attendee_phone <> '') AS phones_remaining,
       count(*)                                     AS rows_in_scope
FROM attendees
WHERE event_id = :'event_id';

-- The WhatsApp send record holds the same numbers twice over: what was sent to,
-- and what Meta canonicalised it to. Left here, a kept dump would carry every
-- messaged attendee's phone number after this script reported zero.
UPDATE whatsapp_sends
SET to_e164 = NULL,
    wa_id = NULL
WHERE event_id = :'event_id'
  AND (to_e164 IS NOT NULL OR wa_id IS NOT NULL);

SELECT count(*) FILTER (WHERE to_e164 IS NOT NULL OR wa_id IS NOT NULL)
         AS send_phones_remaining,
       count(*) AS send_rows_in_scope
FROM whatsapp_sends
WHERE event_id = :'event_id';

-- Door messages keep the number they went to, which makes them one more copy.
UPDATE whatsapp_door_sends
SET to_e164 = NULL
WHERE event_id = :'event_id'
  AND to_e164 IS NOT NULL;

SELECT count(*) FILTER (WHERE to_e164 IS NOT NULL) AS door_phones_remaining,
       count(*)                                    AS door_rows_in_scope
FROM whatsapp_door_sends
WHERE event_id = :'event_id';

COMMIT;
