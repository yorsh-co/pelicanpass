-- Prints the failover gap of one event as a single line of JSON, in the shape
-- gap-input.ts accepts: the check-ins, redemptions and attendee changes
-- recorded after :'t' (the restored snapshot's taken_at).
--
-- Read-only. Run by recover-gap.sh on the primary:
--
--   psql -X -q -t -A -v ON_ERROR_STOP=1 -v t=<taken_at> -v e=<event id> -f -
--
-- Timestamps are rendered in UTC so the output does not depend on the
-- session's zone.

SET TimeZone = 'UTC';

WITH checkins AS (
  SELECT ticket_code, attendee_id, attendee_role, checkin_number, checkin_at
  FROM attendees
  WHERE event_id = :'e'
    AND checkin_complete
    AND checkin_at > :'t'::timestamptz
),
redemptions AS (
  SELECT r.redemption_id, a.ticket_code, r.attendee_id, r.item, r.outcome,
         r.redeemed_by, r.actor_type, r.reason, r.created_at
  FROM redemptions r
  JOIN attendees a ON a.attendee_id = r.attendee_id AND a.event_id = r.event_id
  WHERE r.event_id = :'e'
    AND r.created_at > :'t'::timestamptz
    AND r.outcome IN ('redeemed', 'marked', 'reverted')
),
items AS (
  SELECT DISTINCT ON (a.ticket_code, r.item)
         a.ticket_code, r.item,
         CASE r.item
           WHEN 'tshirt' THEN a.tshirt_redeemed_at
           WHEN 'meal' THEN a.meal_redeemed_at
           WHEN 'drink' THEN a.drink_redeemed_at
           WHEN 'lunch' THEN a.lunch_redeemed_at
           WHEN 'tshirt_volunteer' THEN a.tshirt_volunteer_redeemed_at
         END AS redeemed_at
  FROM redemptions r
  JOIN attendees a ON a.attendee_id = r.attendee_id
)
SELECT json_build_object(
  'takenAt', :'t'::timestamptz,
  'checkins', COALESCE((
    SELECT json_agg(json_build_object(
      'ticketCode', ticket_code,
      'attendeeId', attendee_id,
      'role', attendee_role,
      'checkinNumber', checkin_number,
      'checkinAt', checkin_at
    ) ORDER BY checkin_at, ticket_code) FROM checkins
  ), '[]'::json),
  'redemptions', COALESCE((
    SELECT json_agg(json_build_object(
      'redemptionId', redemption_id,
      'ticketCode', ticket_code,
      'attendeeId', attendee_id,
      'item', item,
      'outcome', outcome,
      'redeemedBy', redeemed_by,
      'actorType', actor_type,
      'reason', reason,
      'createdAt', created_at
    ) ORDER BY created_at, redemption_id) FROM redemptions
  ), '[]'::json),
  'items', COALESCE((
    SELECT json_agg(json_build_object(
      'ticketCode', ticket_code,
      'item', item,
      'redeemedAt', redeemed_at
    ) ORDER BY ticket_code, item) FROM items
  ), '[]'::json),
  'created', COALESCE((
    SELECT json_agg(ticket_code ORDER BY ticket_code)
    FROM attendees
    WHERE event_id = :'e' AND created_at > :'t'::timestamptz
  ), '[]'::json),
  'edited', COALESCE((
    SELECT json_agg(a.ticket_code ORDER BY a.ticket_code)
    FROM attendees a
    WHERE a.event_id = :'e'
      AND a.updated_at > :'t'::timestamptz
      AND a.ticket_code NOT IN (SELECT ticket_code FROM checkins)
      AND a.ticket_code NOT IN (SELECT ticket_code FROM redemptions)
  ), '[]'::json)
);
