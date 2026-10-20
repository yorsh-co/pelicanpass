-- Redacts every direct identifier on an event's attendee rows.
--
-- Run when the event record is retired - after the check-in results have been
-- exported and there is no further reason to hold names. See
-- docs/security/data-retention.md.
--
-- This is the wider job. scripts/db/purge-phone.sql is the narrow one and
-- handles phone numbers alone. Neither is scheduled — see that file's header.
-- Running this one is a separate decision because it destroys the names that
-- reporting and reconciliation read.
--
-- Rows are redacted rather than deleted. `checkin_number` comes from a sequence
-- and `ticket_code` is unique table-wide; deleting rows would leave gaps that
-- look like data loss and would break any downstream count. What remains after
-- this is attendance statistics with nobody attached to them.
--
-- The questionnaire's record of who answered is the exception: it is deleted,
-- and the questionnaire is closed in the same transaction. See its block below.
--
-- Usage, from the repo root:
--
--   set -a; . ./.env; set +a
--   docker compose exec -T db psql \
--     -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
--     -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
--     < scripts/db/purge-attendees.sql
--
-- Take a backup first. This is not reversible.

\set ON_ERROR_STOP on

BEGIN;

-- `ticket_link_token` is rotated rather than cleared. It is a live credential
-- and any printed link should stop working, but the column is NOT NULL UNIQUE,
-- so it cannot be blanked and cannot be set to a shared constant. Rotating with
-- the same expression 004 uses as its default satisfies both and invalidates
-- every issued link.
-- `attendee_nickname` is cleared to NULL rather than to a marker: NULL is what
-- the column means by "not set", and a self-chosen name is personal data on the
-- same footing as `attendee_name`.
-- `team` and `team_role` are cleared to NULL for the same reason. They are free
-- text a coordinator typed, and a role held by one person ("coordenação geral")
-- names them as surely as their name does once it sits beside a ticket code.
UPDATE attendees
SET attendee_phone = '',
    attendee_name = 'REDACTED',
    attendee_nickname = NULL,
    team = NULL,
    team_role = NULL,
    ticket_link_token = translate(
      encode(gen_random_bytes(16), 'base64'), '+/=', '-_'
    ),
    updated_at = now()
WHERE event_id = :'event_id';

SELECT count(*) FILTER (WHERE attendee_phone <> '')          AS phones_remaining,
       count(*) FILTER (WHERE attendee_name <> 'REDACTED')   AS names_remaining,
       count(*) FILTER (WHERE attendee_nickname IS NOT NULL) AS nicknames_remaining,
       count(*) FILTER (WHERE team IS NOT NULL
                          OR team_role IS NOT NULL)          AS teams_remaining,
       count(*)                                              AS rows_in_scope
FROM attendees
WHERE event_id = :'event_id';

-- Telemetry rows are redacted rather than deleted, for the same reason the
-- attendee rows above are: what remains is worth keeping. `fingerprint`,
-- `code`, `route` and `status_code` are what broke and how often, and none of
-- them identifies anybody once the three columns below are gone.
--
-- `ip` and `actor_id` are the direct identifiers. `context` is scrubbed on the
-- way in by telemetry/scrub.ts, but that is a denylist over field names and
-- this is the backstop for a field nobody thought to name.
--
-- `message` is deliberately kept. It is an error string, not a value: pg errors
-- put the offending key in `detail`, which is never stored here. Check it
-- before releasing an export if a new error path has been added since.
UPDATE app_events
SET ip = NULL,
    actor_id = NULL,
    context = NULL
WHERE event_id = :'event_id';

SELECT count(*) FILTER (WHERE ip IS NOT NULL)       AS ips_remaining,
       count(*) FILTER (WHERE actor_id IS NOT NULL) AS actor_ids_remaining,
       count(*) FILTER (WHERE context IS NOT NULL)  AS contexts_remaining,
       count(*)                                     AS event_rows_in_scope
FROM app_events
WHERE event_id = :'event_id';

-- WhatsApp sends are redacted rather than deleted, like the rows above: what
-- was attempted, how it settled and when is worth keeping, and identifies
-- nobody once these four columns are gone.
--
-- `to_e164` and `wa_id` are phone numbers. `wamid` is Meta's message id, which
-- Meta can join back to a number. `error_detail` is Meta's free text and can
-- quote one. `attendee_id` is kept, on the same footing as in `redemptions`.
--
-- `whatsapp_runs` is not touched: it holds a template, an audience, counts and
-- the admin id that started the run, and no attendee data.
UPDATE whatsapp_sends
SET to_e164 = NULL,
    wa_id = NULL,
    wamid = NULL,
    error_detail = NULL
WHERE event_id = :'event_id';

SELECT count(*) FILTER (WHERE to_e164 IS NOT NULL)      AS send_phones_remaining,
       count(*) FILTER (WHERE wa_id IS NOT NULL)        AS wa_ids_remaining,
       count(*) FILTER (WHERE wamid IS NOT NULL)        AS wamids_remaining,
       count(*) FILTER (WHERE error_detail IS NOT NULL) AS error_details_remaining,
       count(*)                                         AS send_rows_in_scope
FROM whatsapp_sends
WHERE event_id = :'event_id';

-- Door messages are redacted on the same terms: `to_e164` is the number and
-- `wamid` joins back to one. `attendee_id` is kept, and so is the status, which
-- is spend the budget still has to count. `whatsapp_door_state` holds no
-- attendee data and is untouched.
UPDATE whatsapp_door_sends
SET to_e164 = NULL,
    wamid = NULL
WHERE event_id = :'event_id';

SELECT count(*) FILTER (WHERE to_e164 IS NOT NULL) AS door_phones_remaining,
       count(*) FILTER (WHERE wamid IS NOT NULL)   AS door_wamids_remaining,
       count(*)                                    AS door_rows_in_scope
FROM whatsapp_door_sends
WHERE event_id = :'event_id';

-- The questionnaire's record of who answered is deleted rather than redacted:
-- `survey_completions` holds nothing but the attendee's id, so there is nothing
-- left worth keeping once it goes. The answers themselves are in
-- `survey_responses`, which names nobody, and are not touched.
--
-- Those rows were also the one-response guard. With them gone an open
-- questionnaire would take a second answer from every attendee whose session is
-- still alive, so it is forced closed here, in the same transaction, where no
-- schedule can reopen it. Reopening it after a purge is a deliberate act on
-- /admin/survey. `updated_by` is NULL because no administrator set this.
DELETE FROM survey_completions
WHERE event_id = :'event_id';

INSERT INTO survey_state (event_id, override, updated_by)
VALUES (:'event_id', 'closed', NULL)
ON CONFLICT (event_id) DO UPDATE
SET override = 'closed',
    updated_by = NULL,
    updated_at = now();

SELECT (SELECT count(*)
        FROM survey_completions
        WHERE event_id = :'event_id')     AS completions_remaining,
       (SELECT override
        FROM survey_state
        WHERE event_id = :'event_id')     AS survey_override;

-- The volunteer permission audit is deleted rather than redacted. Each row
-- holds an attendee id, an administrator id and the before and after of a
-- team and role label - free text that names a person once it sits beside an
-- id - and nothing in it is worth keeping once the roster is redacted.
DELETE FROM volunteer_permission_changes
WHERE event_id = :'event_id';

SELECT count(*) AS permission_changes_remaining
FROM volunteer_permission_changes
WHERE event_id = :'event_id';

COMMIT;
