-- Exports the check-in results, without anything that identifies a person.
--
-- **This is the artifact that outlives the deployment.** The host is torn down
-- roughly 24 hours after the event, taking the `data` volume and every phone
-- number and name with it. What survives is whatever left the box before then,
-- and this is meant to be the only thing that does. See
-- docs/security/data-retention.md.
--
-- Run as the READ-ONLY role. It reads and writes nothing, so there is no reason
-- to hold a credential that could.
--
-- Deliberately omits `attendee_phone` and `attendee_name`. Adding a column here
-- is a retention decision, not a formatting one.
--
-- `archived_at` is here by that rule rather than in spite of it. It identifies
-- nobody — it is a timestamp saying a registration was retired from the event —
-- and without it a retired row and a genuine no-show are the same line, which
-- defeats the per-attendee reconciliation that keeping `ticket_code` is for.
--
-- **Archived rows stay in the export.** Dropping them would change every count
-- and erase the fact that the registration existed at all. The column lets
-- whoever reads the file decide what to do about them, which is the same choice
-- this file already hands them over `ticket_code`.
--
-- It also omits `attendee_nickname`, for a second reason that applies to no
-- other column: the published notice promises the report carries no nickname,
-- **and** it is the one attendee-controlled string in the table. A value like
-- `=cmd|…` is inert in Postgres and executes as a formula the moment a
-- spreadsheet opens the CSV — in the one file meant to outlive the deployment.
--
-- The text the roster import writes can start the same way, so `ticket_code`
-- and every option column go through `regexp_replace`, which prefixes `'` to a
-- value starting with `=`, `+`, `-`, `@`, tab or CR. That is the rule
-- `src/modules/survey/survey.csv.ts` applies, and NULL stays NULL. The role is
-- constrained to two words and the other columns are not text.
--
-- **Pseudonymous, not anonymous.** `ticket_code` re-identifies against the
-- organiser's roster, which lives outside this system and has its own
-- lifecycle. It is here because per-attendee reconciliation — who was expected
-- and did not arrive, who redeemed what — is the point of the export. Drop that
-- one column and the file is genuinely anonymous: counts and timings with
-- nobody attached. Decide which one you are producing before you share it.
--
-- Usage, from the repo root:
--
--   set -a; . ./.env; set +a
--   docker compose exec -T db psql \
--     -U "$POSTGRES_READONLY_USER" -d "$POSTGRES_DB" \
--     -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
--     < scripts/db/export-results.sql > checkin-results.csv
--
-- Then confirm what you are about to keep, before the stack goes:
--
--   head -1 checkin-results.csv | grep -c 'phone\|name'   # expect 0

\set ON_ERROR_STOP on

-- `COPY ... TO STDOUT`, not psql's `\copy`: the meta-command does not expand
-- `:'event_id'`, so the scoping would be a syntax error rather than a silent
-- full-table export. Writing to STDOUT keeps this inside SELECT privileges —
-- `COPY ... TO <file>` is superuser-only, and this runs as the read-only role.
COPY (
  SELECT regexp_replace(ticket_code, '^([=+@\t\r-])', '''\1') AS ticket_code,
         attendee_role,
         checkin_complete,
         checkin_number,
         checkin_at,
         regexp_replace(meal_option, '^([=+@\t\r-])', '''\1') AS meal_option,
         meal_redeemed_at,
         regexp_replace(drink_option, '^([=+@\t\r-])', '''\1') AS drink_option,
         drink_redeemed_at,
         regexp_replace(tshirt_size, '^([=+@\t\r-])', '''\1') AS tshirt_size,
         tshirt_redeemed_at,
         regexp_replace(lunch_option, '^([=+@\t\r-])', '''\1') AS lunch_option,
         lunch_redeemed_at,
         regexp_replace(tshirt_volunteer_size, '^([=+@\t\r-])', '''\1') AS tshirt_volunteer_size,
         tshirt_volunteer_redeemed_at,
         archived_at
  FROM attendees
  WHERE event_id = :'event_id'
  -- Qualified: a bare `ticket_code` would sort by the guarded output column.
  ORDER BY checkin_number NULLS LAST, attendees.ticket_code
) TO STDOUT WITH CSV HEADER;
