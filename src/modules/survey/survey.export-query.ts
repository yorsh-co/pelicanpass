import type { Pool } from 'pg';

import type { AttendeeRole } from '../../types/attendee.ts';
import type { SurveyExportRow } from './survey.csv.ts';

/**
 * One audience's responses, for an export.
 *
 * Kept apart from `survey.repository.ts` so `scripts/survey/export-csv.ts` can
 * run it on its own read-only pool without importing the application's pool,
 * logger or `config/env.ts`. The administrator's download and the script both
 * call it, so the two files cannot select different rows.
 *
 * Ordered by `response_id`, which is random, so no file reproduces the order
 * the answers arrived in. `submitted_on` is read as text: it is a calendar date,
 * and a `Date` in the process's time zone could move it.
 *
 * @param db - Where to run it.
 * @param eventId - The event whose answers are exported.
 * @param audience - Whose responses.
 */
export const selectExportRows = async (
  db: Pick<Pool, 'query'>,
  eventId: string,
  audience: AttendeeRole,
): Promise<SurveyExportRow[]> => {
  const { rows } = await db.query<SurveyExportRow>(
    `SELECT response_id,
      submitted_on::text AS submitted_on,
      survey_version,
      answers
    FROM survey_export
    WHERE event_id = $1
      AND audience = $2
    ORDER BY response_id`,
    [eventId, audience],
  );

  return rows;
};
