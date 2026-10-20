import type { Request, Response } from 'express';

import {
  getAttendeeProfile,
  updateAttendeeNickname,
} from './attendee.repository.ts';
import { attendeeSession } from './attendee.session.adapter.ts';

import { env } from '../../config/env.ts';
import {
  isValidNickname,
  normaliseNickname,
} from '../../constants/nickname.ts';
import { PASS_WINDOW_MS } from '../../constants/pass.ts';
import { welcomeLineAt, welcomePhaseFor } from '../../config/pass-welcome.ts';
import { isSurveyOpenFor } from '../survey/survey.window.ts';
import { renderPassQr } from '../pass/pass.qr.ts';
import { resolveWelcomeSchedule } from '../pass/pass.welcome.ts';
import {
  currentWindow,
  deriveBand,
  issuePassToken,
} from '../pass/pass.service.ts';
import {
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.ts';

import type { AttendeeProfile } from '../../types/attendee.ts';
import type { AccessTier } from '../../constants/access-tier.ts';
import type { RedemptionItem, WelcomeLinePhase } from '../../constants/pass.ts';
import type { PassBand } from '../pass/pass.service.ts';
import type { AttendeeSession } from '../../types/session.ts';

/** One redemption slot's standing, as the pass renders it. */
export interface AttendeePassItem {
  item: RedemptionItem;
  value: string | null;
  redeemedAt: Date | null;
}

/** Everything on the pass that goes stale, as one payload. */
export interface AttendeePass {
  /**
   * The window's band, absent when `PASS_BAND_ENABLED` is off.
   *
   * Optional rather than always sent and sometimes ignored: with the band off
   * there is no band block on the pass to paint it into, and shipping the word
   * anyway would put a value derived from `PASS_SECRET` on the wire for nothing.
   */
  band?: PassBand;
  token: string;
  qr: string;

  /**
   * The three redemption slots.
   *
   * Here rather than left to the page render because they are the only fields
   * on the pass that change during an event. Identity — the name, the number,
   * the ticket code — is fixed once and belongs to the render; anything that
   * moves needs a path to move along, and this is the only one there is.
   */
  items: AttendeePassItem[];

  /**
   * Milliseconds until the current window ends.
   *
   * The browser schedules its own refresh against this rather than against its
   * own clock, so a device whose time is wrong still rotates in step with
   * everyone else's.
   */
  expiresInMs: number;

  /**
   * Whether the questionnaire is open to this attendee, and whether they have
   * answered it.
   *
   * Carried by the back's pass poll and by the front's status poll, so the
   * card appears within half a minute on either face.
   */
  survey: { open: boolean; completed: boolean };

  /**
   * The volunteer's access tier, or `null` for a participant.
   *
   * Sent on every poll rather than rendered once, so a withdrawn permission
   * shows on the pass at its next poll. A display label only.
   */
  accessTier: AccessTier | null;

  /**
   * Which text the welcome line under the name shows, picked here from the
   * schedule in force — the one saved at `/admin/pass`, else
   * `PASS_WELCOME_SCHEDULE` — so every pass switches on the server's clock
   * rather than the device's, then settled against this attendee's
   * questionnaire: `survey` becomes `thanks` once answered, and `default`
   * while it is not open to them. `custom` shows {@link welcomeText} instead
   * of a `pass.welcome` case.
   */
  welcome: WelcomeLinePhase;

  /** The line an administrator wrote, sent only while `welcome` is `custom`. */
  welcomeText?: string;
}

/**
 * The parts of the pass that change during an event, without the credential.
 *
 * What the front of the pass polls: it shows no QR, so it is sent none.
 */
export type AttendeePassStatus = Pick<
  AttendeePass,
  'items' | 'survey' | 'welcome' | 'welcomeText' | 'accessTier'
>;

/** Request and response the service acts on. */
interface AttendeeServiceParams {
  req: Request;
  res: Response;
}

/** Operations available to a signed-in attendee. */
export class AttendeeService {
  readonly req: Request;
  readonly res: Response;
  readonly session: AttendeeSession;
  readonly sessionId: string;

  /**
   * @param params - Request and response for the current call.
   * @throws {Error} If the request carries no attendee session. Every route
   *   that builds this service sits behind `requireSessionType('attendee')`
   *   or `requireWebAuth('attendee', …)`, so this reports a wiring mistake
   *   rather than an unauthenticated caller, which those middlewares reject
   *   with a 401 or a redirect before reaching here.
   */
  constructor({ req, res }: AttendeeServiceParams) {
    const { session, sessionId } = req;

    if (session?.type !== 'attendee' || !sessionId) {
      throw new Error(
        'AttendeeService requires an attendee session on the request',
      );
    }

    this.req = req;
    this.res = res;
    this.session = session;
    this.sessionId = sessionId;
  }

  /**
   * Delete current session. The attendee flow will
   * be redirected to the checkin page.
   */
  async logoutAttendee(): Promise<void> {
    await attendeeSession.destroy(this.req, this.res);
  }

  /**
   * Load the attendee's profile from the database.
   *
   * @returns The profile, or `null` if the session names no attendee or the
   *   attendee has since been removed.
   */
  async getProfile(): Promise<AttendeeProfile | null> {
    const { attendeeId } = this.session;

    if (!attendeeId) return null;

    return await getAttendeeProfile(attendeeId);
  }

  /**
   * Issues the rotating half of the attendee's pass.
   *
   * Returns no identity fields as those are fixed for the life of an event
   * and are loaded on page render. The redemption slots are updated during
   * the event and therefore issued here.
   *
   * Costs one indexed single-row read per call. The questionnaire's state adds
   * no query: completion is an `EXISTS` inside that read, and the window's
   * override is cached in-process.
   *
   * @returns The token, its QR, the redemption slots, the time left in this
   *   window, and the band where it is enabled.
   * @throws {NotFoundError} If the session names no attendee, or the event no
   *   longer holds them.
   */
  async issuePass(): Promise<AttendeePass> {
    const { attendeeId } = this.session;

    if (!attendeeId) throw new NotFoundError('Attendee profile not found');

    const profile = await getAttendeeProfile(attendeeId);

    if (!profile) throw new NotFoundError('Attendee profile not found');

    const window = currentWindow();
    const token = issuePassToken(attendeeId);

    return {
      ...(env.passBandEnabled ? { band: deriveBand(window) } : {}),
      token,
      qr: renderPassQr(token),
      ...(await this.#status(profile)),
      expiresInMs: (window + 1) * PASS_WINDOW_MS - Date.now(),
    };
  }

  /**
   * Reads the redemption slots and the questionnaire's state, for the front
   * of the pass.
   *
   * Same single-row read as {@link issuePass}, without minting a token or
   * rendering a QR that the front would not show.
   *
   * @returns The redemption slots and the questionnaire's state.
   * @throws {NotFoundError} If the session names no attendee, or the event no
   *   longer holds them.
   */
  async readStatus(): Promise<AttendeePassStatus> {
    const profile = await this.getProfile();

    if (!profile) throw new NotFoundError('Attendee profile not found');

    return await this.#status(profile);
  }

  /**
   * Builds the moving parts of the pass from a loaded profile.
   *
   * @param profile - The attendee's profile.
   */
  async #status(profile: AttendeeProfile): Promise<AttendeePassStatus> {
    const survey = {
      open: await isSurveyOpenFor(profile.attendeeRole),
      completed: profile.surveyCompleted,
    };

    const line = welcomePhaseFor(
      welcomeLineAt((await resolveWelcomeSchedule()).entries, Date.now()),
      survey,
    );

    return {
      items: [
        {
          item: 'tshirt_volunteer',
          value: profile.tshirtVolunteerSize,
          redeemedAt: profile.tshirtVolunteerRedeemedAt,
        },
        {
          item: 'lunch',
          value: profile.lunchOption,
          redeemedAt: profile.lunchRedeemedAt,
        },
        {
          item: 'tshirt',
          value: profile.tshirtSize,
          redeemedAt: profile.tshirtRedeemedAt,
        },
        {
          item: 'meal',
          value: profile.mealOption,
          redeemedAt: profile.mealRedeemedAt,
        },
        {
          item: 'drink',
          value: profile.drinkOption,
          redeemedAt: profile.drinkRedeemedAt,
        },
      ],
      survey,
      accessTier: profile.accessTier,
      welcome: line.phase,
      ...(line.phase === 'custom' ? { welcomeText: line.text } : {}),
    };
  }

  /**
   * Sets or clears the display name shown on the attendee's pass.
   *
   * The stored value is the normalised form of what was sent, and it is that
   * form the caller gets back — an echo of the raw input would drift from what
   * the next page load renders.
   *
   * Identity is untouched: `attendee_name` still drives the check-in
   * confirmation preview and the roster at the door.
   *
   * @param raw - Value as received. Empty, or empty once normalised, clears it.
   * @returns The stored value, or `null` if the nickname was cleared.
   * @throws {ValidationError} If the value survives normalisation but breaks
   *   the character policy. The message names no part of the input, which would
   *   otherwise reach the error body and the logs.
   * @throws {NotFoundError} If the session names an attendee the event no
   *   longer holds.
   */
  async setNickname(raw: string): Promise<string | null> {
    const { attendeeId } = this.session;

    if (!attendeeId) throw new NotFoundError('Attendee profile not found');

    const value = normaliseNickname(raw);

    if (value !== '' && !isValidNickname(value)) {
      throw new ValidationError('Invalid nickname');
    }

    const result = await updateAttendeeNickname(
      attendeeId,
      value === '' ? null : value,
    );

    if (!result) throw new NotFoundError('Attendee profile not found');

    return result.nickname;
  }
}
