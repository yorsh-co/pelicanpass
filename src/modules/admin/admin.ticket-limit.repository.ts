import { env } from '../../config/env.ts';
import { WALK_IN_TICKET_PREFIX } from '../../constants/ticket.ts';
import pg from '../../shared/db/postgres.ts';

import type { PoolClient } from 'pg';

import type { Queryable } from './admin.whatsapp.repository.ts';
import type {
  TicketLimitScope,
  TicketLimitSetting,
} from '../../types/ticket-limit.ts';

/**
 * Persistence for the ticket limit: its setting and the count it is measured
 * against.
 *
 * Nothing here decides anything; `admin.ticket-limit.rules.ts` and
 * `admin.ticket-limit.service.ts` own the rules. Every statement is scoped to
 * `env.eventId`.
 */

/**
 * The stored setting.
 *
 * @param db - The pool, or the client holding the limit's lock.
 * @returns The row, or `null` when none exists yet, which means no limit.
 */
export const readTicketLimit = async (
  db: Queryable = pg,
): Promise<TicketLimitSetting | null> => {
  const result = await db.query<TicketLimitSetting>(
    `SELECT scope, cap, mode
    FROM ticket_limit_state
    WHERE event_id = $1`,
    [env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Stores the setting, recording who did it.
 *
 * An upsert, as `writeDoorSwitch` does, because the row does not exist until
 * the first save.
 *
 * @param setting - The validated setting.
 * @param adminId - `admins.admin_id` of the administrator acting.
 */
export const writeTicketLimit = async (
  setting: TicketLimitSetting,
  adminId: string,
): Promise<void> => {
  await pg.query(
    `INSERT INTO ticket_limit_state (event_id, scope, cap, mode, updated_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (event_id) DO UPDATE
      SET scope = EXCLUDED.scope,
          cap = EXCLUDED.cap,
          mode = EXCLUDED.mode,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`,
    [env.eventId, setting.scope, setting.cap, setting.mode, adminId],
  );
};

/**
 * Participant tickets that count towards a scope.
 *
 * Archived attendees and volunteers never count. `door` narrows to the codes
 * the editor generates. Nothing is queried for `off`, which counts nothing.
 *
 * @param scope - The scope being measured.
 * @param db - The pool, or the client holding the limit's lock.
 */
export const countTicketUsage = async (
  scope: TicketLimitScope,
  db: Queryable = pg,
): Promise<number> => {
  if (scope === 'off') return 0;

  // The prefix is a literal today; escaping keeps the pattern a prefix match
  // should it ever gain a wildcard character.
  const generated = `${WALK_IN_TICKET_PREFIX.replace(/[\\%_]/g, '\\$&')}%`;

  const result = await db.query<{ n: string }>(
    `SELECT count(*) AS n
    FROM attendees
    WHERE event_id = $1
      AND archived_at IS NULL
      AND attendee_role = 'participant'
      AND ($2::text IS NULL OR ticket_code LIKE $2)`,
    [env.eventId, scope === 'door' ? generated : null],
  );

  return Number(result.rows[0]?.n ?? 0);
};

/**
 * Serialises ticket-issuing writes for this event until the transaction ends.
 *
 * The count and the write that follows it are a read and a write; without this,
 * two creates at `cap - 1` both read room for one and both insert.
 * Transaction-scoped, so it cannot outlive a failed request.
 *
 * @param client - The client the write's transaction runs on.
 */
export const lockTicketLimit = async (client: PoolClient): Promise<void> => {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `ticket-limit:${env.eventId}`,
  ]);
};
