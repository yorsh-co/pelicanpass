import pkg from 'pg';

import {
  countAttendeeSends,
  countSpendRows,
  isNumberTaken,
  lockDoorBudget,
  readDoorRecipient,
  readDoorSwitch,
  reserveDoorSend,
  settleDoorSend,
  writeDoorSwitch,
} from './admin.whatsapp-door.repository.ts';
import { withTransaction } from './admin.whatsapp.repository.ts';

import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';
import {
  WHATSAPP_TEMPLATES,
  isWhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';
import { consumeWhatsappDoorBudget } from '../../middleware/rate.middleware.ts';
import { ConflictError } from '../../shared/errors/app-error.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import {
  fromMicros,
  priceMicros,
  resolveDoorAvailability,
  resolveReservation,
  spentMicros,
  toMicros,
} from '../whatsapp/whatsapp.budget.ts';
import { sendTemplate } from '../whatsapp/whatsapp.client.ts';
import { doorTemplateProblem } from '../whatsapp/whatsapp.door-template.ts';
import { toE164 } from '../whatsapp/whatsapp.phone.ts';

import type { Request } from 'express';

import type { AttendeeRole } from '../../types/attendee.ts';
import type { AdminSession } from '../../types/session.ts';
import type {
  DoorAvailability,
  DoorOutcome,
  DoorOverview,
  DoorSkipReason,
} from '../../types/whatsapp-door.ts';

/**
 * The door message: one WhatsApp template per role, sent from
 * `/admin/attendees` to an attendee as they are created, or as their number is
 * corrected. One message per number, at most {@link DOOR_MESSAGES_PER_ATTENDEE}
 * per attendee.
 *
 * **Three things must all allow it**, and each has a different owner: `.env`
 * (`WHATSAPP_ENABLED` and `WHATSAPP_DOOR_ENABLED`), which only somebody on the
 * host can change; the switch on the roster, which an administrator holding
 * `whatsapp:send` flips; and `WHATSAPP_BUDGET_USD`, measured against every
 * message Meta has accepted this event. On top of those, the operator ticks or
 * unticks it per attendee, and each account has its own rate limit.
 *
 * **Never throws into the save.** An attendee standing at the door is created,
 * or their corrected number saved, whether or not the message goes;
 * {@link AdminWhatsappDoorService.send} answers with an outcome and the form
 * says what happened.
 *
 * Independent of `/admin/whatsapp`: its runs, its runner and its rows are read
 * for the spend and never written or gated here.
 */

// A misspelt key would otherwise boot cleanly and fail at the first attendee
// through the door. Checked here rather than in env.ts, as survey.window.ts
// checks its question files, because the registry is domain code.
if (env.whatsapp.doorEnabled) {
  const checks = [
    ['WHATSAPP_DOOR_TEMPLATE', env.whatsapp.doorTemplate, 'participant'],
    [
      'WHATSAPP_DOOR_TEMPLATE_VOLUNTEER',
      env.whatsapp.doorTemplateVolunteer,
      'volunteer',
    ],
  ] as const;

  for (const [name, key, role] of checks) {
    const problem = doorTemplateProblem(key, role);

    if (problem) throw new Error(`${name} (${key}) ${problem}`);
  }
}

/**
 * The configured door template's registry key for an attendee's role.
 *
 * @param role - The attendee's committed role.
 */
const doorTemplateFor = (role: AttendeeRole): string =>
  role === 'volunteer'
    ? env.whatsapp.doorTemplateVolunteer
    : env.whatsapp.doorTemplate;

/** Whether `.env` allows door messages at all. */
const isUnlocked = (): boolean =>
  env.whatsapp.enabled && env.whatsapp.doorEnabled;

/**
 * How long a switch read is reused.
 *
 * Every create with the box ticked and every blank form render reads it. Five
 * seconds is the longest another instance keeps sending after the switch is
 * turned off, matching `OVERRIDE_CACHE_MS` in `survey.window.ts`.
 */
const SWITCH_CACHE_MS = 5_000;

/**
 * How many door messages one attendee may have, sent or in flight.
 *
 * One per number already stops a number being messaged twice; this stops a
 * record being cycled through number after number. Three covers the attendee's
 * own number after a wrong one and a parent's, with one to spare. Failed sends
 * do not count, since nothing reached anybody.
 */
const DOOR_MESSAGES_PER_ATTENDEE = 3;

/** The index a second live message to one number violates. */
const NUMBER_ONCE_INDEX = 'whatsapp_door_sends_number_once';

const { DatabaseError } = pkg;

/**
 * Whether an error is two reservations for one number meeting in the index.
 *
 * The budget lock makes this unreachable in practice; it is matched by name so
 * the backstop answers as the check it backs does.
 *
 * @param err - Whatever the reservation threw.
 */
const isNumberCollision = (err: unknown): boolean =>
  err instanceof DatabaseError &&
  err.code === '23505' &&
  err.constraint === NUMBER_ONCE_INDEX;

let cached: { at: number; enabled: Promise<boolean> } | null = null;

/**
 * The switch, read at most once per {@link SWITCH_CACHE_MS}.
 *
 * The promise is cached rather than the value, so concurrent callers share one
 * query, as `cachedOverride` in `survey.window.ts` does.
 */
const cachedSwitch = (): Promise<boolean> => {
  const now = Date.now();

  if (cached && now - cached.at < SWITCH_CACHE_MS) return cached.enabled;

  const enabled = readDoorSwitch();

  cached = { at: now, enabled };

  // A failed read must not be served for the rest of the window.
  enabled.catch(() => {
    cached = null;
  });

  return enabled;
};

/**
 * A `skipped` outcome.
 *
 * @param reason - Why no message was sent.
 */
const skipped = (reason: DoorSkipReason): DoorOutcome => ({
  status: 'skipped',
  reason,
});

/** Operations behind the door message. */
export class AdminWhatsappDoorService {
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
   * The switch, the money and whether a message could go, for the roster's
   * panel.
   *
   * @returns The overview. Spend is read fresh; the switch through the cache.
   */
  async overview(): Promise<DoorOverview> {
    const unlocked = isUnlocked();
    const [switchOn, rows] = await Promise.all([
      cachedSwitch(),
      countSpendRows(),
    ]);

    const spent = spentMicros(rows);
    // The blank form does not know the role yet, so availability is judged
    // against the dearer template; `send()` prices the actual one under the
    // lock.
    const price = Math.max(
      priceMicros(env.whatsapp.doorTemplate),
      priceMicros(env.whatsapp.doorTemplateVolunteer),
    );
    const budget = toMicros(env.whatsapp.budgetUsd);

    return {
      unlocked,
      switchOn,
      availability: resolveDoorAvailability({
        unlocked,
        switchOn,
        spent,
        price,
        budget,
      }),
      spentUsd: fromMicros(spent),
      budgetUsd: fromMicros(budget),
      priceUsd: fromMicros(price),
    };
  }

  /**
   * Whether a door message could be sent now, for the blank form's checkbox.
   *
   * Advisory: the create checks again, under the budget lock.
   */
  async availability(): Promise<DoorAvailability> {
    // Locked costs no query, and is what most deployments are.
    if (!isUnlocked()) return { available: false, reason: 'lockedByEnv' };

    return (await this.overview()).availability;
  }

  /**
   * Turns the switch on or off.
   *
   * @param enabled - The new position.
   * @returns The overview as it now stands.
   * @throws {ConflictError} With `whatsappDoorLocked` when `.env` locks door
   *   messages off: the switch would do nothing, and showing it on would say
   *   otherwise.
   * @throws {Error} If the session carries no admin. The route gate makes that
   *   impossible.
   */
  async setSwitch(enabled: boolean): Promise<DoorOverview> {
    const adminId = this.adminId;

    if (!adminId) throw new Error('Admin session carries no adminId');

    if (!isUnlocked()) {
      throw new ConflictError('Door messages are locked by the environment', {
        reason: 'whatsappDoorLocked',
      });
    }

    await writeDoorSwitch(enabled, adminId);

    cached = null;

    recordEvent({
      severity: 'info',
      kind: 'domain',
      code: 'WHATSAPP_DOOR_SWITCH_SET',
      message: 'Door message switch set',
      actorType: 'admin',
      actorId: adminId,
      fields: { enabled },
    });

    this.req.log.info({ adminId, enabled }, 'Door message switch set');

    return this.overview();
  }

  /**
   * Sends the door message to an attendee who has just been created, or whose
   * record has just been saved, at the number now stored.
   *
   * Gates, in order, each ending in a `skipped` outcome: the `.env` lock, the
   * switch, a stored number Meta can be sent to, that number not already
   * messaged, this account's rate limit, and then — under the budget lock, in
   * one transaction — the number again, the per-attendee cap and the budget.
   * The number is checked before the rate limit as well, so a save that would
   * only repeat a message costs the operator nothing. The reservation is
   * committed **before** the call to Meta, so it counts from that moment.
   *
   * @param attendeeId - The attendee, already committed.
   * @returns What became of the message. Never rejects.
   */
  async send(attendeeId: string): Promise<DoorOutcome> {
    const adminId = this.adminId ?? null;
    const log = this.req.log.child({ adminId, attendeeId });

    try {
      if (!isUnlocked()) return skipped('lockedByEnv');

      if (!(await cachedSwitch())) return skipped('switchedOff');

      const recipient = await readDoorRecipient(attendeeId);

      if (!recipient) return skipped('attendeeUnavailable');

      const key = doorTemplateFor(recipient.attendee_role);

      // Guaranteed by the boot check whenever the lock is open.
      if (!isWhatsappTemplateKey(key)) {
        throw new Error('Door template is not in the registry');
      }

      const to = toE164(
        recipient.attendee_phone,
        env.whatsapp.defaultCountryCode,
      );

      if (!to.ok) return skipped('phoneInvalid');

      if (await isNumberTaken(pg, to.e164)) return skipped('alreadySent');

      if (adminId === null) throw new Error('Admin session carries no adminId');

      const limit = await consumeWhatsappDoorBudget(adminId);

      if (limit.blocked) {
        log.warn('Door message rate limit reached');

        return skipped('rateLimited');
      }

      const price = priceMicros(key);
      const budget = toMicros(env.whatsapp.budgetUsd);

      const reservation = await withTransaction(async (client) => {
        await lockDoorBudget(client);

        const decision = resolveReservation({
          numberTaken: await isNumberTaken(client, to.e164),
          attendeeSends: await countAttendeeSends(client, attendeeId),
          cap: DOOR_MESSAGES_PER_ATTENDEE,
          spent: spentMicros(await countSpendRows(client)),
          price,
          budget,
        });

        if (decision !== 'ok') return decision;

        return reserveDoorSend(client, attendeeId, to.e164, key, adminId);
      }).catch((err: unknown) => {
        if (isNumberCollision(err)) return 'alreadySent' as const;

        throw err;
      });

      if (reservation === 'overBudget') {
        log.warn(
          { budgetUsd: env.whatsapp.budgetUsd },
          'Door message refused: budget reached',
        );

        return skipped('overBudget');
      }

      if (reservation === 'attendeeCapReached') {
        log.warn('Door message refused: attendee cap reached');

        return skipped('attendeeCapReached');
      }

      if (reservation === 'alreadySent') return skipped('alreadySent');

      const outcome = await sendTemplate(
        WHATSAPP_TEMPLATES[key],
        to.e164,
        recipient,
      );

      // Once Meta has answered, the outcome is the answer. A settle that fails
      // leaves the row `sending`, which still counts as spend, and must not
      // tell the operator a delivered message failed.
      try {
        await settleDoorSend(
          reservation,
          outcome.ok
            ? { status: 'sent', wamid: outcome.wamid }
            : {
                status: 'failed',
                errorCode: outcome.code,
                errorTitle: outcome.title,
              },
        );
      } catch (err) {
        log.error({ err, sendId: reservation }, 'Door message settle failed');
      }

      if (outcome.ok) {
        log.info({ sendId: reservation }, 'Door message sent');

        return { status: 'sent' };
      }

      log.warn(
        { sendId: reservation, code: outcome.code, title: outcome.title },
        'Door message not sent',
      );

      return { status: 'failed' };
    } catch (err) {
      // Never the recipient row: it carries the entry link token.
      log.error({ err }, 'Door message failed');

      return { status: 'failed' };
    }
  }
}
