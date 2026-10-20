import { count } from '../../shared/telemetry/counters.ts';
import crypto from 'crypto';

import {
  applyPresence,
  applyStep,
  getNextStep,
  isComplete,
} from './checkin.flow.ts';
import { checkinSession } from './checkin.session.adapter.ts';
import { recordFailedAttempt } from './checkin.attempts.ts';

import { maskName, maskPhone } from '../../shared/utils/mask.ts';
import { qrService } from '../qr/qr.service.ts';
import { env } from '../../config/env.ts';
import {
  consumeCheckinEntryFailure,
  consumeVerificationFailure,
  isCheckinFailureBudgetExhausted,
} from '../../middleware/rate.middleware.ts';
import {
  CaptchaRequiredError,
  CheckinNotOpenError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors/app-error.ts';
import { attendeeSession } from '../attendee/attendee.session.adapter.ts';
import {
  getAttendeeByTicket,
  getAttendeeByLinkToken,
  completeCheckin,
} from '../attendee/attendee.repository.ts';
import { isValidTicketCode } from '../../constants/ticket.ts';
import { QR_TOKEN_PATTERN } from '../../constants/qr-token.ts';
import { assertCheckinOpen } from './checkin.window.ts';

import type { Request, Response } from 'express';

import type { FailableStep } from './checkin.attempts.ts';
import type { AttendeeTicketRow } from '../attendee/attendee.repository.ts';
import type { AttendeeRole } from '../../types/attendee.ts';
import type { CheckinProgress, CheckinStep } from '../../types/checkin.ts';
import type { AttendeePreview, CheckinSession } from '../../types/session.ts';

/** Request and response the service acts on. */
interface CheckinServiceParams {
  req: Request;
  res: Response;
}

/**
 * Entry points that can seed a check-in from a link.
 *
 * `linkToken` is the opaque per-attendee token a printed ticket QR encodes, not
 * the ticket code the attendee types. The two are deliberately different
 * credentials — see attendee.repository.getAttendeeByLinkToken.
 */
interface CheckinInitOptions {
  qrToken?: string | undefined;
  linkToken?: string | undefined;
}

/** The part of the session the browser is allowed to see. */
interface CheckinSessionView {
  progress: CheckinProgress;
  attendeePreview: Partial<AttendeePreview>;
  attendeeRole: AttendeeRole | null;

  /**
   * Present only on the response that completes the check-in.
   *
   * The number is assigned by `completeCheckin`, which runs after the step has
   * already built its payload, so no step can populate this itself — see
   * `#persistAndRespond`.
   */
  checkinNumber?: number | null;
}

/** Payload accompanying a check-in response, omitted when empty. */
interface CheckinResponseData {
  session?: CheckinSessionView;
}

/** Where the flow stands once a step has been applied. */
interface CheckinResponseMeta {
  nextStep: CheckinStep;
  captchaRequired: boolean;
}

/** What every public method on the service resolves to. */
interface CheckinResponse {
  meta: CheckinResponseMeta;
  data?: CheckinResponseData;
}

/** A step's effect on the session, plus what to tell the browser. */
interface CheckinStepResult {
  session: CheckinSession;
  data: CheckinResponseData;
}

export class CheckinService {
  readonly req: Request;
  readonly res: Response;

  /**
   * Assigned by `#initSession`, which every public method awaits before
   * touching the session. Declared as always-present so the reads below do
   * not each have to re-establish what that call already guarantees.
   */
  session!: CheckinSession;

  sessionId = '';

  /**
   * Whether the global checkin-entry failure budget is currently spent, which
   * raises the captcha requirement for every caller rather than only for the
   * session that ran the failures up.
   *
   * Resolved once per call by `#initSession` and reported through response
   * metadata, so the browser renders a captcha without the flag ever being
   * written to a session the client could discard.
   */
  globalCaptchaRequired = false;

  /**
   * @param params - Request and response for the current call.
   */
  constructor({ req, res }: CheckinServiceParams) {
    this.req = req;
    this.res = res;
  }

  // =========================
  // PUBLIC API
  // =========================

  /**
   * Initialize a checkin session.
   * Accepts initialization with a QR Code token
   * or a ticket code.
   *
   * @param options - Token or ticket code carried by the entry link.
   */
  async init({
    qrToken,
    linkToken,
  }: CheckinInitOptions): Promise<CheckinResponse> {
    await this.#initSession();

    let data: CheckinResponseData = {};

    if (this.session.currentStep !== 'init') {
      data.session = {
        progress: this.session.progress,
        attendeePreview: this.session.attendeePreview,
        attendeeRole: this.session.attendeeRole,
      };
    }

    if (linkToken && !this.session.progress.ticket) {
      this.session.source = 'ticket';

      const result = await this.#withGlobalFailureTracking(() =>
        this.#processTicketLink(linkToken),
      );

      this.session = result.session;

      data = { ...data, ...result.data };

      return this.#persistAndRespond(this.session, data);
    }

    if (qrToken && !this.session.progress.qr) {
      this.session.source = 'qr';

      const result = await this.#withGlobalFailureTracking(() =>
        this.#processQrToken(qrToken),
      );

      this.session = result.session;

      data = { ...data, ...result.data };

      return this.#persistAndRespond(this.session, data);
    }

    return this.#persistAndRespond(this.session, data);
  }

  /**
   * Submit ticket code.
   *
   * @param ticketCode - Ticket code submitted by the attendee.
   */
  async submitTicket(ticketCode: string): Promise<CheckinResponse> {
    await this.#initSession();

    if (this.session.progress.ticket) {
      return await this.#persistAndRespond(this.session, {
        session: {
          progress: this.session.progress,
          attendeePreview: this.session.attendeePreview,
          attendeeRole: this.session.attendeeRole,
        },
      });
    }

    try {
      const { session, data } = await this.#withGlobalFailureTracking(() =>
        this.#processTicket(ticketCode),
      );

      return await this.#persistAndRespond(session, data);
    } catch (err) {
      if (err instanceof CheckinNotOpenError) throw err;

      return await this.#handleFailure('ticket', err);
    }
  }

  /**
   * Submit verification code.
   *
   * @param verificationCode - Last four phone digits, as entered.
   */
  async submitVerification(verificationCode: string): Promise<CheckinResponse> {
    await this.#initSession();

    if (this.session.progress.verified) {
      return await this.#persistAndRespond(this.session, {
        session: {
          progress: this.session.progress,
          attendeePreview: this.session.attendeePreview,
          attendeeRole: this.session.attendeeRole,
        },
      });
    }

    try {
      const { session, data } =
        await this.#processVerification(verificationCode);

      const rotated = await checkinSession.rotate(
        this.req,
        this.res,
        this.sessionId,
      );

      this.sessionId = rotated.sessionId;

      return await this.#persistAndRespond(session, data);
    } catch (err) {
      return await this.#handleFailure('verification', err);
    }
  }

  /**
   * Submit QR code.
   *
   * @param qrCode - Raw payload read by the scanner.
   * @throws {UnauthorizedError} If the session cannot have reached the scan,
   *   before any failure budget is charged.
   */
  async submitQrCode(qrCode: string): Promise<CheckinResponse> {
    await this.#initSession();

    if (this.session.progress.qr) {
      return await this.#persistAndRespond(this.session, {
        session: {
          progress: this.session.progress,
          attendeePreview: this.session.attendeePreview,
          attendeeRole: this.session.attendeeRole,
        },
      });
    }

    // The client only scans from a verified session. Anything else means the
    // session expired or its cookie was dropped, and ensure issued a blank one.
    if (!this.session.progress.verified && this.session.source !== 'qr') {
      throw new UnauthorizedError();
    }

    try {
      const token = qrService.extractToken(qrCode);

      if (!token) throw new ValidationError('Invalid QR token');

      const { session, data } = await this.#withGlobalFailureTracking(() =>
        this.#processQrToken(token),
      );

      return await this.#persistAndRespond(session, data);
    } catch (err) {
      return await this.#handleFailure('qr', err);
    }
  }

  /**
   * Continue a verified attendee whom staff marked present from the staff
   * lookup, in place of scanning the venue QR code.
   *
   * Each "not marked present yet" answer is charged to the session's `qr`
   * failure counter, which scans share, so mixing the two cannot double the
   * allowance. At its threshold the session is locked and reset like any other
   * step. It is deliberately not charged to the global check-in failure
   * budget: the session is already bound to one verified attendee and submits
   * no input, so this is not a credential guess, and charging it would let a
   * busy help desk raise a captcha for every attendee at the door.
   *
   * @throws {UnauthorizedError} If the session has not been verified, before
   *   any failure budget is charged.
   * @throws {NotMarkedPresentError} If staff have not confirmed the attendee.
   * @throws {CaptchaRequiredError} If this answer crossed the lockout
   *   threshold.
   * @throws {Error} If the session carries no ticket code, which is a wiring
   *   fault rather than anything the attendee did.
   */
  async checkPresence(): Promise<CheckinResponse> {
    await this.#initSession();

    if (this.session.progress.qr) {
      return await this.#persistAndRespond(this.session, {
        session: {
          progress: this.session.progress,
          attendeePreview: this.session.attendeePreview,
          attendeeRole: this.session.attendeeRole,
        },
      });
    }

    // There is no `source === 'qr'` exemption as in submitQrCode: a poster-scan
    // entry has no attendee to look up. An unverified session means it expired
    // or its cookie was dropped, and ensure issued a blank one.
    if (!this.session.progress.verified) throw new UnauthorizedError();

    const { ticketCode } = this.session.ticket;
    if (!ticketCode) throw new Error('Missing ticketCode in session');

    try {
      // An archived attendee reads as `null`, which is not present.
      const attendee = await getAttendeeByTicket(ticketCode);

      const updated = applyPresence(
        this.session,
        attendee?.checkin_complete ?? false,
      );

      const response = await this.#persistAndRespond(updated, {
        session: {
          progress: updated.progress,
          attendeePreview: updated.attendeePreview,
          attendeeRole: updated.attendeeRole,
        },
      });

      this.req.log.info(
        { attendeeId: this.session.attendeeId },
        'Presence confirmed from volunteer check-in',
      );

      return response;
    } catch (err) {
      return await this.#handleFailure('qr', err);
    }
  }

  /**
   * Reset checkin progress by deleting current session
   * and generating a new session. The checkin flow will
   * be reset to the first step, with the captcha flag
   * set accordingly.
   */
  async resetCheckin(): Promise<CheckinResponse> {
    await this.#initSession();

    const { captchaRequired } = this.session;

    const { sessionId, session } = await checkinSession.reset(
      this.req,
      this.res,
    );

    session.captchaRequired = captchaRequired;

    this.sessionId = sessionId;
    this.session = session;

    return await this.#persistAndRespond(session);
  }

  // =========================
  // ORCHESTRATION HELPERS
  // =========================

  /**
   * Initialize checkin session
   */
  async #initSession(): Promise<void> {
    const { sessionId, session } = await checkinSession.ensure(
      this.req,
      this.res,
    );

    this.sessionId = sessionId;
    this.session = session;
    this.globalCaptchaRequired = await isCheckinFailureBudgetExhausted();
  }

  /**
   * Record a failed attempt for the given step and persist it
   * in the session.
   *
   * Always throws: the original error, a lockout error once the step crosses
   * its captcha threshold, or a rate limit error once an attendee's
   * verification budget is spent.
   *
   * @param step - Step that failed.
   * @param err - Error the step raised.
   */
  async #handleFailure(step: FailableStep, err: unknown): Promise<never> {
    // Verification failures are charged to the attendee being verified, not to
    // the session. The session counter below is UX — it drives the "attempts
    // left" copy — but it lives behind a cookie the client can drop, so this is
    // the budget that actually gates guessing.
    if (step === 'verification' && this.session.attendeeId) {
      const { blocked, retryAfterSeconds } = await consumeVerificationFailure(
        this.session.attendeeId,
      );

      if (blocked) {
        this.req.log.warn(
          { attendeeId: this.session.attendeeId, retryAfterSeconds },
          'Attendee verification failure budget exhausted',
        );

        throw new RateLimitError('Too many requests', retryAfterSeconds);
      }
    }

    const updated = recordFailedAttempt(this.session, step);

    this.session = updated;

    if (updated.captchaRequired) {
      this.req.log.warn(
        { step, failedAttempts: updated.failedAttempts },
        'Checkin session locked - captcha required',
      );

      // Persist before resetting. resetCheckin re-reads the session through
      // #initSession, so without this the flag raised above is dropped and the
      // replacement session is issued unlocked — the lockout would never
      // actually engage.
      await checkinSession.persist(this.sessionId, updated);

      // perform user "lockout" by resetting the session
      // and cookie and requiring a captcha token
      const { meta } = await this.resetCheckin();

      throw new CaptchaRequiredError(
        'Too many failed attempts. Please complete the verification.',
        meta, // { nextStep: 'ticket', captchaRequired: true }
      );
    }

    await checkinSession.persist(this.sessionId, updated);

    throw err;
  }

  /**
   * Persist session data and return response data.
   *
   * If all checkin steps are complete, a new attendee
   * session is generated and the checkin session is destroyed.
   *
   * @param session - Session state to store.
   * @param data - Payload to return alongside the metadata.
   */
  async #persistAndRespond(
    session: CheckinSession,
    data: CheckinResponseData = {},
  ): Promise<CheckinResponse> {
    this.session = session;

    if (isComplete(session.progress)) {
      await this.#processCheckinComplete();

      // The arrival number is the payoff the success screen shows, and it only
      // exists once the line above has run — by which point the step that
      // built `data` is long finished.
      if (data.session) data.session.checkinNumber = this.session.checkinNumber;

      await this.#issueAttendeeSession();

      await checkinSession.destroy(this.req, this.res);
    } else {
      await checkinSession.persist(this.sessionId, session);
    }

    const response: CheckinResponse = { meta: this.#buildMeta(session) };

    if (Object.keys(data).length > 0) response.data = data;

    return response;
  }

  /**
   * Build response metadata.
   *
   * @param session - Session the metadata describes.
   */
  #buildMeta(session: CheckinSession): CheckinResponseMeta {
    return {
      nextStep: getNextStep(session.progress),
      captchaRequired: session.captchaRequired || this.globalCaptchaRequired,
    };
  }

  /**
   * Run a lookup, charging the global failure budget when it fails.
   *
   * Exhausting the budget raises a captcha requirement for every caller rather
   * than returning 429. Blocking would hand an attacker a way to shut the door
   * on legitimate attendees by failing on purpose; an inline Turnstile costs a
   * scripted guesser far more than it costs someone standing in the queue.
   *
   * The requirement is not applied here — it is state the next request reads
   * through `isCheckinFailureBudgetExhausted`, so the original error is what
   * this call reports.
   *
   * @param handler - Lookup to run.
   */
  async #withGlobalFailureTracking<T>(
    handler: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await handler();
    } catch (err) {
      if (err instanceof CheckinNotOpenError) throw err;

      const { blocked, retryAfterSeconds } = await consumeCheckinEntryFailure();

      if (blocked) {
        this.globalCaptchaRequired = true;

        this.req.log.warn(
          { retryAfterSeconds },
          'Checkin entry failure budget exhausted - captcha required globally',
        );
      }

      throw err;
    }
  }

  // =========================
  // DOMAIN STEP HANDLERS
  // =========================

  /**
   * Process a ticket code the attendee typed in.
   *
   * @param ticketCode - Ticket code to validate and apply.
   */
  async #processTicket(ticketCode: string): Promise<CheckinStepResult> {
    return this.#applyTicket(await validateTicket(ticketCode));
  }

  /**
   * Process the opaque token carried by an entry link.
   *
   * Resolves to the same attendee as the typed code would, by a different
   * credential — the link never carries anything the attendee could type.
   *
   * @param linkToken - Token from the entry link's `t` parameter.
   */
  async #processTicketLink(linkToken: string): Promise<CheckinStepResult> {
    return this.#applyTicket(await validateTicketLink(linkToken));
  }

  /**
   * Apply resolved attendee fields as the ticket step.
   *
   * @param fields - Session fields the lookup produced.
   */
  #applyTicket(fields: Partial<CheckinSession>): CheckinStepResult {
    assertCheckinOpen(fields.attendeeRole, this.req);

    const updated = applyStep(this.session, 'ticket', fields);

    return {
      session: updated,
      data: {
        session: {
          progress: updated.progress,
          attendeePreview: updated.attendeePreview,
          attendeeRole: updated.attendeeRole,
        },
      },
    };
  }

  /**
   * Process attendee verification code.
   *
   * @param verificationCode - Code to check against the attendee record.
   */
  async #processVerification(
    verificationCode: string,
  ): Promise<CheckinStepResult> {
    const fields = await verifyAttendee(this.session, verificationCode);

    const updated = applyStep(this.session, 'verification', fields);

    return {
      session: updated,
      data: {
        session: {
          progress: updated.progress,
          attendeePreview: updated.attendeePreview,
          attendeeRole: updated.attendeeRole,
        },
      },
    };
  }

  /**
   * Process qr token.
   *
   * @param qrToken - Token extracted from the scanned code.
   */
  #processQrToken(qrToken: string): CheckinStepResult {
    validateQrToken(qrToken);

    const updated = applyStep(this.session, 'qr', {
      eventId: env.eventId, // TODO: derive the event ID from the qrToken
      qr: { qrToken },
    });

    return {
      session: updated,
      data: {
        session: {
          progress: updated.progress,
          attendeePreview: updated.attendeePreview,
          attendeeRole: updated.attendeeRole,
        },
      },
    };
  }

  /**
   * Trigger checkin completion interaction with the database.
   * Stores the checkinNumber and checkinAt timestamp in the session.
   *
   * This is the last gate before the row is written, and it has to be one: the
   * QR step touches no database, so an attendee archived between their
   * verification code and the poster scan would otherwise be marked present.
   * `completeCheckin` answers `null` in that case, and the refusal is the same
   * uniform `ValidationError` every other entry refusal on this surface raises
   * — a `NotFoundError` would be the one signal separating "archived" from
   * "wrong code".
   *
   * The message names the ticket rather than the QR because that is what is
   * actually no longer valid, even though the step that failed is the scan.
   *
   * @throws {ValidationError} If no active attendee holds the session's ticket.
   * @throws {Error} If the session carries no ticket code, which is a wiring
   *   fault rather than anything the attendee did.
   */
  async #processCheckinComplete(): Promise<void> {
    const { ticketCode } = this.session.ticket;
    if (!ticketCode) throw new Error('Missing ticketCode in session');

    const completed = await completeCheckin(ticketCode);

    if (!completed) {
      this.req.log.warn(
        { attendeeId: this.session.attendeeId },
        'Checkin completion refused: no active attendee holds this ticket',
      );

      throw new ValidationError('Invalid ticket code');
    }

    const { checkinNumber, checkinAt } = completed;

    this.req.log.info(
      {
        attendeeId: this.session.attendeeId,
        checkinNumber,
        attendeeRole: this.session.attendeeRole,
        source: this.session.source,
      },
      'Checkin complete',
    );

    // Feeds the door-stalled rule: requests arriving with no completions while
    // the window is open is what "the app is up but nobody can check in" looks
    // like from inside the process.
    count('checkin.complete');

    this.session.checkinNumber = checkinNumber;
    // Stored as epoch ms: the session round-trips through JSON in Redis, so a
    // Date would come back as a string on the next request.
    this.session.checkinAt = checkinAt.getTime();
  }

  /**
   * Issue attendee session.
   *
   * The attendee is seeded through the adapter's overrides rather than
   * written in a second pass, so the session is never readable with a null
   * attendeeId.
   */
  async #issueAttendeeSession(): Promise<void> {
    const { attendeeId, attendeeRole } = this.session;

    await attendeeSession.create(this.req, this.res, {
      attendeeId,
      attendeeRole,
    });
  }
}

/** Shape of the token an entry link carries: 16 random bytes, base64url. */
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Maps a resolved attendee row onto the fields the ticket step contributes.
 *
 * Shared by both lookups so the two credentials produce identical session
 * state — only the way the attendee was found differs.
 *
 * @param attendee - Row returned by either lookup.
 * @returns Session fields the ticket step contributes.
 */
const toTicketFields = (
  attendee: AttendeeTicketRow,
): Partial<CheckinSession> => {
  const fullPhone = attendee.attendee_phone;
  const ticketCode = attendee.ticket_code;

  return {
    attendeeId: attendee.attendee_id,
    attendeeRole: attendee.attendee_role,
    ticket: { ticketCode },

    attendeePreview: {
      ticketCode: ticketCode,
      name: maskName(attendee.attendee_name),
      phoneStart: maskPhone(fullPhone),
    },

    checkinComplete: attendee.checkin_complete,
    checkinAt: attendee.checkin_at?.getTime() ?? null,
    checkinNumber: attendee.checkin_number,
  };
};

/**
 * Validate a ticket code typed in by the attendee.
 *
 * A malformed code and an unknown one raise the identical error on purpose:
 * distinguishing them would tell an enumerator which codes exist. Resist
 * "improving" these messages.
 *
 * @param ticketCode - Ticket code as submitted.
 * @returns Session fields the ticket step contributes.
 * @throws {ValidationError} If the code is malformed or unknown.
 */
const validateTicket = async (
  ticketCode: string,
): Promise<Partial<CheckinSession>> => {
  if (!ticketCode || !isValidTicketCode(ticketCode)) {
    throw new ValidationError('Invalid ticket code');
  }

  const attendee = await getAttendeeByTicket(ticketCode);
  if (!attendee) {
    throw new ValidationError('Invalid ticket code');
  }

  return toTicketFields(attendee);
};

/**
 * Validate the opaque token carried by an entry link.
 *
 * Same indistinguishable-failure rule as {@link validateTicket}, and the same
 * error text, so the two entry paths cannot be told apart either.
 *
 * @param linkToken - Token from the entry link's `t` parameter.
 * @returns Session fields the ticket step contributes.
 * @throws {ValidationError} If the token is malformed or unknown.
 */
const validateTicketLink = async (
  linkToken: string,
): Promise<Partial<CheckinSession>> => {
  if (!linkToken || !LINK_TOKEN_RE.test(linkToken)) {
    throw new ValidationError('Invalid ticket code');
  }

  const attendee = await getAttendeeByLinkToken(linkToken);
  if (!attendee) {
    throw new ValidationError('Invalid ticket code');
  }

  return toTicketFields(attendee);
};

/**
 * Verify attendee by validating the verification code.
 *
 * All three failure paths raise the identical error on purpose — a missing
 * ticket, an unknown one and a wrong code must not be distinguishable.
 *
 * The attendee row is read here anyway, so its check-in state is returned for
 * the session to pick up: a volunteer may have marked the attendee present
 * since the ticket step.
 *
 * @param session - Session identifying the attendee being verified.
 * @param code - Code as entered by the attendee.
 * @returns Session fields the verification step contributes.
 * @throws {ValidationError} If the code is malformed or does not match.
 */
const verifyAttendee = async (
  session: CheckinSession,
  code: string,
): Promise<
  Pick<CheckinSession, 'checkinAt' | 'checkinNumber' | 'checkinComplete'>
> => {
  const { ticketCode } = session.ticket;
  const isValidFormat = /^[0-9]{4}$/.test(code);

  if (!ticketCode || !code || !isValidFormat) {
    throw new ValidationError('Invalid verification code');
  }

  const attendee = await getAttendeeByTicket(ticketCode);
  if (!attendee) {
    throw new ValidationError('Invalid verification code');
  }

  const submitted = Buffer.from(code, 'utf8');
  const expected = Buffer.from(attendee.attendee_phone.slice(-4), 'utf8');

  // timingSafeEqual throws on a length mismatch rather than returning false, so
  // the lengths are compared first. Reaching here with unequal lengths takes a
  // stored number shorter than four digits, which the importer should never
  // produce.
  if (
    submitted.length !== expected.length ||
    !crypto.timingSafeEqual(submitted, expected)
  ) {
    throw new ValidationError('Invalid verification code');
  }

  return {
    checkinComplete: attendee.checkin_complete,
    checkinAt: attendee.checkin_at?.getTime() ?? null,
    checkinNumber: attendee.checkin_number,
  };
};

/**
 * Validate the QR Code token.
 *
 * The token is printed on the venue poster, so it is public: it shows the
 * scan happened in the room, not who scanned it, and is a flow step rather
 * than a control. That is why the comparison is a plain `!==` rather than
 * constant-time, and why the token is never rotated or time-boxed; there is
 * no secret to leak and a reprint mid-event would strand the room.
 *
 * @param qrToken - Token extracted from the scanned code.
 * @throws {ValidationError} If the token is malformed or not this event's.
 */
const validateQrToken = (qrToken: string): boolean => {
  const isValidFormat = QR_TOKEN_PATTERN.test(qrToken);

  if (!isValidFormat || !qrToken || qrToken !== env.checkinQrToken) {
    throw new ValidationError('Invalid QR token');
  }

  return true;
};
