-- Resets the load-test stack's event to a pre-doors state and prints the k6
-- fixtures as one JSON array.
--
-- Run after importing the roster from scripts/loadtest/roster.ts, and again
-- before every load-test run so each one starts from the same state. Redis is
-- reset separately - see docs/performance/load-testing.md.
--
-- Refuses to run if the event holds any attendee whose code is not synthetic,
-- so pointing it at a real database by mistake fails before the first write.
--
-- Usage, from the repo root, against the load-test stack only:
--
--   docker compose -f compose.loadtest.yml exec -T db psql \
--     -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
--     -v event_id="$EVENT_ID" \
--     < scripts/loadtest/prepare.sql > loadtest/fixtures.json
--
-- Codes are vlt plus three characters for volunteers and lt0 plus three for
-- participants.
--
-- Grants: the first ten volunteers (vlt000 to vlt009) may redeem, and the
-- eleventh (vlt00a) may draw.

\set QUIET on
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

BEGIN;

-- psql does not interpolate inside a dollar-quoted body, so the guard reads
-- the event from a transaction-local setting instead.
SET LOCAL loadtest.event_id = :'event_id';

DO $$
DECLARE
  real_rows integer;
BEGIN
  SELECT count(*) INTO real_rows
  FROM attendees
  WHERE event_id = current_setting('loadtest.event_id')
    AND ticket_code !~ '^(vlt|lt0)[a-z0-9]{3}$';

  IF real_rows > 0 THEN
    RAISE EXCEPTION 'refusing to run: % non-synthetic attendee(s) in this event', real_rows;
  END IF;
END
$$;

-- Children first: redemptions reference attendees.
DELETE FROM redemptions WHERE event_id = :'event_id';
DELETE FROM raffle_draws WHERE event_id = :'event_id';
DELETE FROM survey_completions WHERE event_id = :'event_id';
DELETE FROM survey_responses WHERE event_id = :'event_id';
DELETE FROM survey_state WHERE event_id = :'event_id';

UPDATE attendees
SET checkin_complete = false,
    checkin_at = NULL,
    checkin_number = NULL,
    meal_redeemed_at = NULL,
    drink_redeemed_at = NULL,
    tshirt_redeemed_at = NULL,
    lunch_redeemed_at = NULL,
    tshirt_volunteer_redeemed_at = NULL,
    attendee_nickname = NULL,
    archived_at = NULL,
    can_redeem = ticket_code BETWEEN 'vlt000' AND 'vlt009',
    can_draw = ticket_code = 'vlt00a',
    updated_at = now()
WHERE event_id = :'event_id';

COMMIT;

SELECT coalesce(json_agg(json_build_object(
         'ticket', ticket_code,
         'code', right(attendee_phone, 4),
         'link', ticket_link_token,
         'role', attendee_role,
         'canRedeem', can_redeem,
         'canDraw', can_draw
       ) ORDER BY attendee_role, ticket_code), '[]')
FROM attendees
WHERE event_id = :'event_id';
