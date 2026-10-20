import type { Request } from 'express';

import { env } from '../../config/env.ts';
import {
  decodeStoredSchedule,
  welcomeLineAt,
} from '../../config/pass-welcome.ts';
import { ConflictError } from '../../shared/errors/app-error.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import { readWelcomeState } from './pass.welcome.repository.ts';
import { pickWelcomeSchedule, saveWelcomeSchedule } from './pass.welcome.ts';

import type {
  WelcomeLine,
  WelcomeScheduleEntry,
} from '../../config/pass-welcome.ts';
import type { AdminSession } from '../../types/session.ts';
import type { WelcomeScheduleSource } from './pass.welcome.ts';
import type { WelcomeScheduleSave } from './pass.admin.rules.ts';

/** Everything `/admin/pass` shows. */
export interface PassWelcomeOverview {
  /** Which schedule passes follow. */
  source: WelcomeScheduleSource;

  /** The line scheduled now, before any attendee's questionnaire settles it. */
  current: WelcomeLine;

  /** The next switch in the schedule in force, or `null` after the last. */
  next: WelcomeScheduleEntry | null;

  /** `PASS_WELCOME_SCHEDULE`, as parsed at boot. */
  defaults: readonly WelcomeScheduleEntry[];

  /** The saved schedule, or `null` when none is saved or it is unreadable. */
  saved: WelcomeScheduleEntry[] | null;

  /** What a save must name to apply; `0` before the first. */
  revision: number;
}

/** The pass's welcome schedule, as an administrator manages it. */
export class PassAdminService {
  readonly req: Request;

  /**
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /** The administrator a save is recorded against. */
  get adminId(): string | undefined {
    const session = this.req.session as AdminSession | undefined;

    return session?.adminId ?? undefined;
  }

  /**
   * The schedule in force, where it comes from, and both candidates.
   *
   * Read fresh rather than through the pass's cache, so the editor starts from
   * what is stored and names the revision a save must match, even in the
   * seconds after another instance saved.
   */
  async overview(): Promise<PassWelcomeOverview> {
    const state = await readWelcomeState();
    const resolved = pickWelcomeSchedule(state, env.passWelcomeSchedule);
    const now = Date.now();

    return {
      source: resolved.source,
      current: welcomeLineAt(resolved.entries, now),
      next: resolved.entries.find((entry) => entry.at > now) ?? null,
      defaults: env.passWelcomeSchedule,
      saved:
        state === null || state.schedule === null
          ? null
          : decodeStoredSchedule(state.schedule),
      revision: state?.revision ?? 0,
    };
  }

  /**
   * Saves a schedule, or hands back to `.env`, and records who did.
   *
   * The event carries the count of entries and nothing about any attendee.
   *
   * @param save - The schedule and the revision it was made against.
   * @returns The new revision.
   * @throws {ConflictError} With `scheduleChanged`, if another save landed
   *   after the page was rendered. Nothing is written.
   * @throws {Error} If the session carries no admin. The route gate makes that
   *   impossible, so it is a 500 rather than a refusal.
   */
  async save({ schedule, revision }: WelcomeScheduleSave): Promise<number> {
    const adminId = this.adminId;

    if (!adminId) throw new Error('Admin session carries no adminId');

    const saved = await saveWelcomeSchedule(schedule, adminId, revision);

    if (saved === null) {
      throw new ConflictError('Welcome schedule changed since it was read', {
        reason: 'scheduleChanged',
      });
    }

    recordEvent({
      severity: 'info',
      kind: 'domain',
      code:
        schedule === null
          ? 'PASS_WELCOME_SCHEDULE_RESET'
          : 'PASS_WELCOME_SCHEDULE_SET',
      message:
        schedule === null
          ? 'Welcome schedule handed back to .env'
          : 'Welcome schedule saved',
      actorType: 'admin',
      actorId: adminId,
      fields:
        schedule === null
          ? { revision: saved }
          : { entries: schedule.length, revision: saved },
    });

    return saved;
  }
}
