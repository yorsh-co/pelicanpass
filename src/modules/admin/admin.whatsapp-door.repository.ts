import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import type { PoolClient } from 'pg';

import type { Queryable } from './admin.whatsapp.repository.ts';
import type { TemplateAttendeeRow } from '../../constants/whatsapp-templates.ts';
import type { AttendeeRole } from '../../types/attendee.ts';
import type { SpendRow } from '../whatsapp/whatsapp.budget.ts';

/**
 * Persistence for the door message: its switch, its sends, and the spend the
 * budget is measured against.
 *
 * Nothing here validates; `admin.whatsapp-door.service.ts` owns the rules.
 * Every statement is scoped to `env.eventId`. **Read-only against
 * `whatsapp_sends`**: the bulk sender's rows are counted, never written.
 */

/**
 * The switch as stored.
 *
 * @returns Whether it is on. `false` when no row exists yet.
 */
export const readDoorSwitch = async (): Promise<boolean> => {
  const result = await pg.query<{ enabled: boolean }>(
    `SELECT enabled
    FROM whatsapp_door_state
    WHERE event_id = $1`,
    [env.eventId],
  );

  return result.rows[0]?.enabled ?? false;
};

/**
 * Turns the switch on or off, recording who did it.
 *
 * An upsert, as `writeOverride` in `survey.repository.ts`, because the row does
 * not exist until the first flip.
 *
 * @param enabled - The new position.
 * @param adminId - `admins.admin_id` of the administrator acting.
 */
export const writeDoorSwitch = async (
  enabled: boolean,
  adminId: string,
): Promise<void> => {
  await pg.query(
    `INSERT INTO whatsapp_door_state (event_id, enabled, updated_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (event_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`,
    [env.eventId, enabled, adminId],
  );
};

/**
 * Every send that counts towards this event's spend, per template.
 *
 * A bulk send counts once Meta accepted it (`sent`). A door send counts from
 * the moment it is reserved (`sending`), so two operators at the edge of the
 * budget cannot both fit, and a crash mid-call leaves the money accounted for.
 * Meta bills delivered messages only, so this is an upper bound on the bill.
 *
 * @param db - The pool, or the client holding the budget lock.
 */
export const countSpendRows = async (
  db: Queryable = pg,
): Promise<SpendRow[]> => {
  const result = await db.query<{ template_key: string; n: string }>(
    `SELECT template_key, count(*) AS n
    FROM (
      SELECT template_key
      FROM whatsapp_sends
      WHERE event_id = $1
        AND status = 'sent'
      UNION ALL
      SELECT template_key
      FROM whatsapp_door_sends
      WHERE event_id = $1
        AND status IN ('sending', 'sent')
    ) counted
    GROUP BY template_key`,
    [env.eventId],
  );

  return result.rows.map((row) => ({
    templateKey: row.template_key,
    count: Number(row.n),
  }));
};

/**
 * Serialises door reservations for this event until the transaction ends.
 *
 * The budget check and the reservation that follows it are a read and a
 * write; without this, two creates at the edge both read room for one message
 * and both reserve. Transaction-scoped, so it cannot outlive a failed request.
 *
 * @param client - The client the reservation's transaction runs on.
 */
export const lockDoorBudget = async (client: PoolClient): Promise<void> => {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `whatsapp-door-budget:${env.eventId}`,
  ]);
};

/**
 * Whether a door message to this number is already sent or in flight.
 *
 * Failed sends do not count: the number never received anything, so a retry is
 * allowed.
 *
 * @param db - The pool, or the client holding the budget lock.
 * @param toE164 - The number, as sent to Meta.
 */
export const isNumberTaken = async (
  db: Queryable,
  toE164: string,
): Promise<boolean> => {
  const result = await db.query(
    `SELECT 1
    FROM whatsapp_door_sends
    WHERE event_id = $1
      AND to_e164 = $2
      AND status IN ('sending', 'sent')
    LIMIT 1`,
    [env.eventId, toE164],
  );

  return result.rowCount !== 0;
};

/**
 * How many door messages an attendee has had, sent or in flight.
 *
 * @param db - The client holding the budget lock.
 * @param attendeeId - The attendee.
 */
export const countAttendeeSends = async (
  db: Queryable,
  attendeeId: string,
): Promise<number> => {
  const result = await db.query<{ n: string }>(
    `SELECT count(*) AS n
    FROM whatsapp_door_sends
    WHERE event_id = $1
      AND attendee_id = $2
      AND status IN ('sending', 'sent')`,
    [env.eventId, attendeeId],
  );

  return Number(result.rows[0]?.n ?? 0);
};

/**
 * Reserves one door message, as `sending`.
 *
 * The caller has checked the number, the attendee's cap and the budget under
 * the budget lock. A `23505` on `whatsapp_door_sends_number_once` is raised, not
 * handled: it is the backstop for that check.
 *
 * @param client - The client holding the budget lock.
 * @param attendeeId - The attendee.
 * @param toE164 - The number about to be sent to.
 * @param templateKey - The template about to be sent.
 * @param adminId - The administrator who saved the attendee.
 * @returns The row's ID.
 */
export const reserveDoorSend = async (
  client: PoolClient,
  attendeeId: string,
  toE164: string,
  templateKey: string,
  adminId: string,
): Promise<string> => {
  const result = await client.query<{ send_id: string }>(
    `INSERT INTO whatsapp_door_sends
      (event_id, attendee_id, template_key, to_e164, status, created_by)
    VALUES ($1, $2, $3, $4, 'sending', $5)
    RETURNING send_id`,
    [env.eventId, attendeeId, templateKey, toE164, adminId],
  );

  const row = result.rows[0];

  if (!row) throw new Error('Door send insert returned no row');

  return row.send_id;
};

/** What Meta's answer comes to, for {@link settleDoorSend}. */
export type DoorSettlement =
  | { status: 'sent'; wamid: string }
  | { status: 'failed'; errorCode: number | null; errorTitle: string };

/**
 * Records how a reserved send ended.
 *
 * Only a `sending` row moves, so a settlement can never rewrite one that has
 * already ended.
 *
 * @param sendId - Row to settle.
 * @param settlement - Its new status and what Meta said.
 */
export const settleDoorSend = async (
  sendId: string,
  settlement: DoorSettlement,
): Promise<void> => {
  const sent = settlement.status === 'sent';

  await pg.query(
    `UPDATE whatsapp_door_sends
      SET status = $1,
        wamid = $2,
        error_code = $3,
        error_title = $4,
        sent_at = CASE WHEN $1::text = 'sent' THEN now() ELSE NULL END
    WHERE send_id = $5
      AND event_id = $6
      AND status = 'sending'`,
    [
      settlement.status,
      sent ? settlement.wamid : null,
      sent ? null : settlement.errorCode,
      sent ? null : settlement.errorTitle,
      sendId,
      env.eventId,
    ],
  );
};

/** The columns a door message is built from. */
export interface DoorRecipientRow extends TemplateAttendeeRow {
  attendee_phone: string;
  attendee_role: AttendeeRole;
}

/**
 * The attendee's row, as committed, for building the message.
 *
 * Read back rather than handed over by the save: the number is the one just
 * written, and `ticket_link_token` is a live entry credential that is kept out
 * of the save's return value and so out of its response.
 *
 * @param attendeeId - The attendee just created or saved.
 * @returns The row, or `null` when it is gone or archived.
 */
export const readDoorRecipient = async (
  attendeeId: string,
): Promise<DoorRecipientRow | null> => {
  const result = await pg.query<DoorRecipientRow>(
    `SELECT
      attendee_name,
      attendee_phone,
      attendee_role,
      ticket_code,
      ticket_link_token,
      team,
      checkin_time,
      lunch_option
    FROM attendees
    WHERE attendee_id = $1
      AND event_id = $2
      AND archived_at IS NULL`,
    [attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};
