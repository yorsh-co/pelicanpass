import {
  countTicketUsage,
  lockTicketLimit,
  readTicketLimit,
  writeTicketLimit,
} from './admin.ticket-limit.repository.ts';
import {
  countsTowards,
  readTicketLimitInput,
  resolveTicketLimit,
  wouldRefuse,
} from './admin.ticket-limit.rules.ts';

import { ConflictError } from '../../shared/errors/app-error.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';

import type { Request } from 'express';
import type { PoolClient } from 'pg';

import type { AttendeeRole } from '../../types/attendee.ts';
import type { AdminSession } from '../../types/session.ts';
import type { TicketLimitOverview } from '../../types/ticket-limit.ts';

/**
 * The ticket limit: the setting an administrator holding `attendees:limit`
 * edits, and the guard the attendees editor runs before it issues or restores
 * a participant ticket.
 *
 * The decisions are `admin.ticket-limit.rules.ts`'s and the SQL is
 * `admin.ticket-limit.repository.ts`'s; this class gathers the facts and acts
 * on the answers. Nothing here records personal data: events carry the
 * setting and the counts, never a name or a code.
 */

/**
 * The limit as it stands: the stored setting against the current count.
 *
 * Standalone so a reader with no request, such as the metrics snapshot, can ask
 * without constructing the service.
 *
 * @returns The overview. A missing row is `off`.
 */
export const readTicketLimitOverview =
  async (): Promise<TicketLimitOverview> => {
    const setting = await readTicketLimit();

    return resolveTicketLimit(
      setting,
      await countTicketUsage(setting?.scope ?? 'off'),
    );
  };

/** Operations behind the ticket limit. */
export class AdminTicketLimitService {
  readonly req: Request;

  /** @param req - Request carrying an already-gated admin session. */
  constructor(req: Request) {
    this.req = req;
  }

  /** The administrator acting. */
  get adminId(): string | undefined {
    const session = this.req.session as AdminSession | undefined;

    return session?.adminId ?? undefined;
  }

  /**
   * The limit as it stands: the stored setting against the current count.
   *
   * @returns The overview. A missing row is `off`.
   */
  overview(): Promise<TicketLimitOverview> {
    return readTicketLimitOverview();
  }

  /**
   * Replaces the setting.
   *
   * A plain setter, safe to repeat. Lowering the cap below usage is allowed and
   * shows as `over`.
   *
   * @param body - Parsed request body: `{ scope, cap, mode }`.
   * @returns The overview under the new setting.
   * @throws {ValidationError} With `ticketLimitScope`, `ticketLimitCap` or
   *   `ticketLimitMode` if the body is malformed.
   * @throws {Error} If the session carries no admin. The route gate makes that
   *   impossible.
   */
  async set(body: unknown): Promise<TicketLimitOverview> {
    const adminId = this.adminId;

    if (!adminId) throw new Error('Admin session carries no adminId');

    const setting = readTicketLimitInput(body);

    await writeTicketLimit(setting, adminId);

    recordEvent({
      severity: 'info',
      kind: 'domain',
      code: 'TICKET_LIMIT_SET',
      message: 'Ticket limit set',
      actorType: 'admin',
      actorId: adminId,
      fields: {
        scope: setting.scope,
        mode: setting.mode,
        ...(setting.cap === null ? {} : { cap: setting.cap }),
      },
    });

    this.req.log.info(
      { adminId, scope: setting.scope, cap: setting.cap, mode: setting.mode },
      'Ticket limit set',
    );

    return this.overview();
  }

  /**
   * Checks that one more attendee may be issued, inside the caller's
   * transaction.
   *
   * **Locks before it reads the setting, every time.** Locking only when the
   * limit is already on would leave a window for somebody turning it on
   * mid-save. The lock is released with the caller's `COMMIT` or `ROLLBACK`, so
   * the write that follows is counted by the next guard.
   *
   * The refusal carries no figures: `ConflictError` details have no place for
   * them, and the form's banner already shows them.
   *
   * @param client - The client the caller's transaction runs on.
   * @param role - The role being written.
   * @param ticketCode - The code being written, normalised.
   * @returns The overview **as it will be once this write commits**, or `null`
   *   when there is no limit.
   * @throws {ConflictError} With `ticketLimitReached` when the limit is hard,
   *   the attendee counts and the cap is already used.
   */
  async guard(
    client: PoolClient,
    role: AttendeeRole,
    ticketCode: string,
  ): Promise<TicketLimitOverview | null> {
    await lockTicketLimit(client);

    const setting = await readTicketLimit(client);
    const scope = setting?.scope ?? 'off';

    if (scope === 'off') return null;

    const before = resolveTicketLimit(
      setting,
      await countTicketUsage(scope, client),
    );
    const counted = countsTowards(scope, role, ticketCode);

    if (wouldRefuse(before, counted)) {
      throw new ConflictError('Ticket limit reached', {
        reason: 'ticketLimitReached',
      });
    }

    return counted ? resolveTicketLimit(setting, before.used + 1) : before;
  }

  /**
   * Records that a counted write left a `warn` limit at or over its cap.
   *
   * Called after the write commits, so a rolled-back attempt records nothing. A
   * `hard` limit is never reported: it reaches its cap by design and refuses
   * the next write. Carries the figures and the scope, nothing about who was
   * issued.
   *
   * @param limit - The overview {@link guard} returned for the write.
   * @param role - The role that was written.
   * @param ticketCode - The code that was written, normalised.
   */
  recordExceeded(
    limit: TicketLimitOverview | null,
    role: AttendeeRole,
    ticketCode: string,
  ): void {
    if (
      limit?.mode !== 'warn' ||
      (limit.status !== 'reached' && limit.status !== 'over') ||
      !countsTowards(limit.scope, role, ticketCode)
    ) {
      return;
    }

    recordEvent({
      severity: 'warn',
      kind: 'domain',
      code: 'TICKET_LIMIT_EXCEEDED',
      message: 'Ticket limit reached or exceeded',
      actorType: 'admin',
      ...(this.adminId ? { actorId: this.adminId } : {}),
      fields: {
        used: limit.used,
        scope: limit.scope,
        ...(limit.cap === null ? {} : { cap: limit.cap }),
      },
    });
  }
}
