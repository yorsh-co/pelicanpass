import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';
import { readAnsweringRole } from '../attendee/attendee.repository.ts';
import { selectExportRows } from './survey.export-query.ts';

import type { Pool } from 'pg';

import type { AttendeeRole } from '../../types/attendee.ts';
import type { PreparedResponse, SurveyOverride } from '../../types/survey.ts';
import type { SurveyExportRow } from './survey.csv.ts';

/**
 * Persistence for the questionnaire's tables.
 *
 * `survey_state` is one row per event, holding an administrator's override of
 * the schedule. It lives in Postgres rather than Redis or `.env` because a
 * decision to open early has to survive a container recreate, and must not
 * need a shell on the host.
 *
 * `survey_completions` records who answered and `survey_responses` what was
 * answered, with nothing joining them; see migration `020`.
 */

/**
 * The event's override.
 *
 * @returns `open` or `closed`, or `null` when no row exists or the row leaves
 *   the schedule in charge.
 */
export const readOverride = async (): Promise<SurveyOverride | null> => {
  const result = await pg.query<{ override: SurveyOverride | null }>(
    `SELECT override
    FROM survey_state
    WHERE event_id = $1`,
    [env.eventId],
  );

  return result.rows[0]?.override ?? null;
};

/**
 * Sets or clears the event's override, recording who did it.
 *
 * An upsert, because the row does not exist until the first override. The
 * default on `updated_at` applies only to the insert, so the update sets it.
 *
 * @param override - `open` or `closed`, or `null` to hand back to the schedule.
 * @param adminId - `admins.admin_id` of the administrator acting.
 */
export const writeOverride = async (
  override: SurveyOverride | null,
  adminId: string,
): Promise<void> => {
  await pg.query(
    `INSERT INTO survey_state (event_id, override, updated_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (event_id) DO UPDATE
      SET override = EXCLUDED.override,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`,
    [env.eventId, override, adminId],
  );
};

/** How a submission ended, for the service to turn into a response. */
export type SubmissionOutcome = 'recorded' | 'answered' | 'not-found';

/**
 * Records one attendee's answers, once.
 *
 * One transaction. The role is read from the attendee row, not the session,
 * and handed to `prepare`, which checks the answers against that role's
 * questions — so the definition they are checked against and the audience they
 * are stored under come from the same row and cannot disagree. Anything
 * `prepare` throws rolls the transaction back and propagates.
 *
 * The completion is written first, with `ON CONFLICT DO NOTHING`: no row back
 * means this attendee already answered, and the response is never written. Two
 * submits in flight at once serialise on the completion's primary key, and
 * exactly one gets a row. The response insert has no `RETURNING`, because the
 * application role cannot read that table.
 *
 * @param attendeeId - Attendee from the session.
 * @param prepare - Checks the answers for a role and returns what to store.
 * @returns `recorded`; `answered` if they already had; `not-found` if they are
 *   archived, not checked in, or gone.
 */
export const recordSubmission = async (
  attendeeId: string,
  prepare: (role: AttendeeRole) => PreparedResponse,
): Promise<SubmissionOutcome> => {
  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    const role = await readAnsweringRole(client, attendeeId);

    if (role === null) {
      await client.query('ROLLBACK');

      return 'not-found';
    }

    const { audience, version, answers } = prepare(role);

    const completion = await client.query(
      `INSERT INTO survey_completions (event_id, attendee_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING attendee_id`,
      [env.eventId, attendeeId],
    );

    if (completion.rowCount === 0) {
      await client.query('ROLLBACK');

      return 'answered';
    }

    await client.query(
      `INSERT INTO survey_responses (event_id, audience, survey_version, answers)
      VALUES ($1, $2, $3, $4)`,
      [env.eventId, audience, version, JSON.stringify(answers)],
    );

    await client.query('COMMIT');

    return 'recorded';
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};

/**
 * How many responses each audience has given.
 *
 * Read through `survey_export`, the only thing the application may read
 * responses from.
 *
 * @returns A count for both audiences, zero where there are none.
 */
export const countResponses = async (): Promise<
  Record<AttendeeRole, number>
> => {
  const { rows } = await pg.query<{ audience: AttendeeRole; n: string }>(
    `SELECT audience, count(*) AS n
    FROM survey_export
    WHERE event_id = $1
    GROUP BY audience`,
    [env.eventId],
  );

  const counts: Record<AttendeeRole, number> = { participant: 0, volunteer: 0 };

  for (const row of rows) counts[row.audience] = Number(row.n);

  return counts;
};

/**
 * One audience's responses, for the administrator's download.
 *
 * @param audience - Whose responses.
 * @param db - Where to run it. The application's pool unless a caller brings
 *   its own.
 * @see selectExportRows
 */
export const readExportRows = (
  audience: AttendeeRole,
  db: Pick<Pool, 'query'> = pg,
): Promise<SurveyExportRow[]> => selectExportRows(db, env.eventId, audience);
