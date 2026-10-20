import type { Request, Response } from 'express';

import { count } from '../../shared/telemetry/counters.ts';

import { mintReviewHandle, resolveReviewHandle } from './staff.repository.ts';

import {
  getAttendeeByTicket,
  getAttendeeProfile,
  redeemItem,
} from '../attendee/attendee.repository.ts';
import {
  currentWindow,
  deriveBand,
  releasePassToken,
  verifyPassToken,
} from '../pass/pass.service.ts';

import {
  PASS_WINDOW_MS,
  REDEEMABLE_ITEMS,
  isVolunteerOnlyItem,
} from '../../constants/pass.ts';
import { isValidTicketCode } from '../../constants/ticket.ts';
import { consumeStaffLookupFailure } from '../../middleware/rate.middleware.ts';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../../shared/errors/app-error.ts';

import type {
  RedemptionItem,
  RedemptionOutcome,
} from '../../constants/pass.ts';
import type { PassBand } from '../pass/pass.service.ts';
import type { AttendeeProfile } from '../../types/attendee.ts';
import type { AttendeeSession } from '../../types/session.ts';

/** Request and response the service acts on. */
interface StaffServiceParams {
  req: Request;
  res: Response;
}

/**
 * How the volunteer's screen names the person in front of them.
 *
 * A participant is named by the number on their pass; a volunteer has
 * no number and is named by their registered first name.
 */
export type ServedIdentifier =
  | { kind: 'checkinNumber'; value: number }
  | { kind: 'firstName'; value: string };

/** One item's standing for the attendee being served. */
export interface ServedItem {
  item: RedemptionItem;
  label: string;

  /** What they registered for — a t-shirt size, a meal choice. */
  value: string | null;

  /** Null until collected. Present means a second attempt is a duplicate. */
  redeemedAt: Date | null;

  inScope: boolean;
}

/** What a volunteer sees after a successful scan or lookup. */
export interface ReviewView {
  handle: string;
  attendeeRole: AttendeeProfile['attendeeRole'];
  identifier: ServedIdentifier;
  items: ServedItem[];
}

/** The band, for the volunteer's own screen. */
export interface StaffBand {
  band: PassBand;
  expiresInMs: number;
}

/** The outcome of handing one item over. */
export interface RedeemResult {
  outcome: RedemptionOutcome;
  item: RedemptionItem;
  label: string;
  redeemedAt: Date | null;
}

/**
 * Builds the identifier a volunteer compares against the pass in front of them.
 *
 * @param profile - The attendee being served.
 * @throws {NotFoundError} If a participant carries no check-in number.
 */
const identify = (profile: AttendeeProfile): ServedIdentifier => {
  if (profile.attendeeRole === 'volunteer') {
    return { kind: 'firstName', value: profile.attendeeFirstName };
  }

  if (profile.checkinNumber === null) {
    throw new NotFoundError('Attendee record is incomplete');
  }

  return { kind: 'checkinNumber', value: profile.checkinNumber };
};

/**
 * Flattens the profile's redemption pairs into one ordered list.
 *
 * Volunteer-only items are left off a participant's card rather than shown as
 * not entitled: the database never lets a participant hold them, so the row
 * could only ever say no.
 *
 * @param profile - The attendee being served.
 * @param scopes - What the volunteer reading it may record.
 */
const itemsOf = (
  profile: AttendeeProfile,
  scopes: RedemptionItem[],
): ServedItem[] =>
  [
    {
      item: 'tshirt_volunteer' as const,
      label: REDEEMABLE_ITEMS.tshirt_volunteer,
      value: profile.tshirtVolunteerSize,
      redeemedAt: profile.tshirtVolunteerRedeemedAt,
    },
    {
      item: 'lunch' as const,
      label: REDEEMABLE_ITEMS.lunch,
      value: profile.lunchOption,
      redeemedAt: profile.lunchRedeemedAt,
    },
    {
      item: 'tshirt' as const,
      label: REDEEMABLE_ITEMS.tshirt,
      value: profile.tshirtSize,
      redeemedAt: profile.tshirtRedeemedAt,
    },
    {
      item: 'meal' as const,
      label: REDEEMABLE_ITEMS.meal,
      value: profile.mealOption,
      redeemedAt: profile.mealRedeemedAt,
    },
    {
      item: 'drink' as const,
      label: REDEEMABLE_ITEMS.drink,
      value: profile.drinkOption,
      redeemedAt: profile.drinkRedeemedAt,
    },
  ]
    .filter(
      (entry) =>
        !isVolunteerOnlyItem(entry.item) ||
        profile.attendeeRole === 'volunteer',
    )
    .map((entry) => ({ ...entry, inScope: scopes.includes(entry.item) }));

/** Operations available to a volunteer permitted to record redemptions. */
export class StaffService {
  readonly req: Request;
  readonly res: Response;
  readonly session: AttendeeSession;

  /** Which items this volunteer may record, from the gate that let them in. */
  readonly scopes: RedemptionItem[];

  /**
   * @param params - Request and response for the current call.
   * @throws {Error} If the request carries no attendee session or no scopes.
   *   Every route that builds this service sits behind
   *   `requireSessionType('attendee')` and `requireRedeemPermission`, so either
   *   absence reports a wiring mistake rather than an unauthorised caller.
   */
  constructor({ req, res }: StaffServiceParams) {
    const { session, redeemScopes } = req;

    if (session?.type !== 'attendee' || !session.attendeeId) {
      throw new Error('StaffService requires an attendee session');
    }

    if (!redeemScopes) {
      throw new Error('StaffService requires resolved redeem scopes');
    }

    this.req = req;
    this.res = res;
    this.session = session;
    this.scopes = redeemScopes;
  }

  /** The volunteer's own attendee ID, recorded against everything they do. */
  get volunteerId(): string {
    // Narrowed by the constructor; the session type allows null in general.
    return this.session.attendeeId ?? '';
  }

  /**
   * The current band, for the volunteer's own timer.
   *
   * Derived from the same secret and window as every attendee's, which is the
   * entire mechanism: the two screens agree because neither was told what the
   * other shows.
   */
  getBand(): StaffBand {
    const window = currentWindow();

    return {
      band: deriveBand(window),
      expiresInMs: (window + 1) * PASS_WINDOW_MS - Date.now(),
    };
  }

  /**
   * Verifies a scanned pass and opens a review.
   *
   * The token is spent by `verifyPassToken` before anything else happens, so a
   * replay is refused even if everything after it fails. It is given back only
   * when the failure was infrastructure — see the `catch` below.
   *
   * Both outcomes are logged against the volunteer rather than left to
   * `errorHandler`, which records the session type but not who was holding the
   * scanner. A run of refusals from one volunteer is how a broken camera or a
   * station-wide problem becomes visible on the day, and the successes are what
   * give that run a denominator.
   *
   * @param token - Raw payload scanned from the attendee's pass.
   * @throws {ValidationError} If the token is expired, forged, malformed or
   *   already spent. Expiry is distinguishable because it is the one benign
   *   case with an action attached; the rest are deliberately identical.
   */
  async verify(token: string): Promise<ReviewView> {
    const result = await verifyPassToken(token);

    if (!result.ok) {
      // Expiry is ordinary — a phone that slept in the queue shows a stale
      // code. Everything else should be rare enough that a warn means something.
      const level = result.reason === 'expired' ? 'info' : 'warn';

      // Indexed rather than held in a local, which would unbind pino's `this`.
      this.req.log[level](
        { volunteerId: this.volunteerId, reason: result.reason },
        'Pass verification refused',
      );

      throw new ValidationError(
        result.reason === 'expired' ? 'Pass expired' : 'Invalid pass',
      );
    }

    try {
      const review = await this.#openReview(result.attendeeId);

      this.req.log.info(
        { attendeeId: result.attendeeId, volunteerId: this.volunteerId },
        'Pass verified',
      );

      return review;
    } catch (err) {
      // The token was spent for a review that never opened. Give it back, so
      // the attendee is not left waiting out a window with a volunteer in front
      // of them for a failure that was ours.
      //
      // Only an infrastructure failure is ours. An AppError is a settled fact
      // about the attendee's record — a participant carrying no check-in
      // number, a profile that is not there — and the retry a release would buy
      // reaches the same answer, having left a live token replayable for the
      // rest of its window.
      if (!(err instanceof AppError)) {
        await releasePassToken(token).catch((releaseErr: unknown) => {
          this.req.log.warn({ err: releaseErr }, 'Pass token release failed');
        });
      }

      throw err;
    }
  }

  /**
   * Opens a review from a typed identifier instead of a scan.
   *
   * The broken-camera path. It keys on the ticket code alone — the one
   * identifier every attendee carries, in both role shapes, and the reason the
   * code is printed on the pass.
   *
   * Deliberately **not** a fallback for a Redis outage — it mints a handle like
   * any other review, and without Redis there is no session to reach it with.
   *
   * **A miss is charged to the volunteer.** Resolving a bare code to an
   * attendee's identifier and entitlements is exactly the oracle every other
   * guessing surface here is budgeted against, and the session limiter above it
   * is the blunt control `checkinEntryIpLimiter` disclaims. A malformed query is
   * *not* charged: it cannot be an issued code, so it is not part of the oracle,
   * and the page validates shape before the round trip anyway.
   *
   * @param query - A ticket code, as typed.
   * @throws {ValidationError} If the query is not a well-formed ticket code.
   * @throws {NotFoundError} If nothing in this event matches.
   * @throws {RateLimitError} If this volunteer has spent their miss budget.
   */
  async lookup(query: string): Promise<ReviewView> {
    const trimmed = query.trim().toLowerCase();

    const attendeeId = await this.#resolveLookup(trimmed);

    if (!attendeeId) {
      const { blocked, retryAfterSeconds } = await consumeStaffLookupFailure(
        this.volunteerId,
      );

      if (blocked) {
        this.req.log.warn(
          { volunteerId: this.volunteerId, retryAfterSeconds },
          'Staff lookup failure budget exhausted',
        );

        throw new RateLimitError('Too many requests', retryAfterSeconds);
      }

      throw new NotFoundError('Attendee not found');
    }

    const review = await this.#openReview(attendeeId);

    // Logged rather than written to `redemptions`: that table records what was
    // handed over, and a lookup hands over nothing. A run of these is how
    // "the scanner stopped working" becomes visible on the day.
    this.req.log.info(
      { attendeeId, volunteerId: this.volunteerId },
      'Staff lookup used instead of a scan',
    );

    return review;
  }

  /**
   * Records that one item was handed to the attendee under review.
   *
   * Every outcome is a success at the HTTP level. `duplicate` is the answer to
   * a question the volunteer asked, not a failure of their request, and a 4xx
   * would push it into the client's error path where it would read as a fault.
   *
   * An item outside this volunteer's station is refused before the handle is
   * even resolved, and **not** written to `redemptions`. That table records what
   * happened at the counter against an attendee's entitlements, and this never
   * reached the attendee's record — it is a permission event of the same kind
   * `requireRedeemPermission` logs, so it is logged the same way.
   *
   * The scopes come from the row read on this request, not from the one that
   * minted the handle, so a volunteer moved between stations with a review card
   * already open is refused on their next tap.
   *
   * The handle itself is checked against the session presenting it. Resolving a
   * handle says who it was minted for; it does not say that the person holding
   * it is that volunteer, and `redeemItem` writes the minted volunteer to the
   * audit row either way.
   *
   * @param handle - Review handle from `verify` or `lookup`.
   * @param item - Which item was handed over.
   * @throws {ForbiddenError} If the item is outside this volunteer's scopes, or
   *   the handle was minted for a different volunteer.
   * @throws {NotFoundError} If the handle is unknown or has expired.
   */
  async redeem(handle: string, item: RedemptionItem): Promise<RedeemResult> {
    if (!this.scopes.includes(item)) {
      this.req.log.warn(
        { volunteerId: this.volunteerId, item, scopes: this.scopes },
        "Redemption refused: item outside this volunteer's scopes",
      );

      throw new ForbiddenError();
    }

    const review = await resolveReviewHandle(handle);

    if (!review) {
      this.req.log.warn(
        { volunteerId: this.volunteerId, item },
        'Redemption refused: review handle did not resolve',
      );

      throw new NotFoundError('Review expired');
    }

    // The handle is a bearer credential for its 120 seconds, and `redeemItem`
    // records the volunteer it was minted for. Without this, a handle that
    // reached a second volunteer would write that volunteer's action under the
    // first one's name, in the one table kept to answer who did what.
    if (review.volunteerId !== this.volunteerId) {
      this.req.log.warn(
        { volunteerId: this.volunteerId, mintedBy: review.volunteerId, item },
        'Redemption refused: handle belongs to another volunteer',
      );

      throw new ForbiddenError();
    }

    const { outcome, redeemedAt } = await redeemItem(
      review.attendeeId,
      item,
      review.volunteerId,
    );

    this.req.log.info(
      {
        attendeeId: review.attendeeId,
        volunteerId: review.volunteerId,
        item,
        outcome,
      },
      'Redemption recorded',
    );

    // Counted, not stored: `redemptions` is already the durable record of this,
    // and a second copy in `app_events` would be a second source of truth about
    // the evening that nobody reconciles.
    //
    // Keyed by outcome rather than a single total, because the three mean
    // different things at the counter — `duplicate` is somebody trying twice,
    // `not_entitled` is a roster problem, and only `redeemed` is throughput.
    count(`redeem.${outcome}`);

    return { outcome, item, label: REDEEMABLE_ITEMS[item], redeemedAt };
  }

  /** Loads the attendee and mints the handle the redeem step will carry. */
  async #openReview(attendeeId: string): Promise<ReviewView> {
    const profile = await getAttendeeProfile(attendeeId);

    if (!profile) throw new NotFoundError('Attendee not found');

    const identifier = identify(profile);

    const handle = await mintReviewHandle({
      attendeeId,
      volunteerId: this.volunteerId,
    });

    return {
      handle,
      attendeeRole: profile.attendeeRole,
      identifier,
      items: itemsOf(profile, this.scopes),
    };
  }

  /** Turns a typed ticket code into an attendee ID. */
  async #resolveLookup(query: string): Promise<string | null> {
    if (!isValidTicketCode(query)) {
      throw new ValidationError('Invalid lookup');
    }

    const found = await getAttendeeByTicket(query);

    return found?.attendee_id ?? null;
  }
}
