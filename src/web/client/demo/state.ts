/**
 * The demo's backend: pure state and one transition per endpoint.
 *
 * A handler takes the current state and a request and returns the next state
 * with the status and body the production API would answer. Nothing here
 * touches the DOM, storage, the clock or a random source: the caller passes
 * them in with the request, which is what lets `node:test` drive it directly.
 *
 * Behaviour follows the server modules it stands in for (`src/modules/checkin`,
 * `attendee`, `staff`, `raffle`, `survey`) wherever the attendee interface can
 * tell the difference, including the error codes and the captcha lockout. What
 * it leaves out is what a single visitor cannot meet: rate limits, the
 * per-attendee verification budget, spent pass tokens and review-handle
 * expiry.
 */

import { metricsSnapshot } from './metrics-snapshot.ts';
import { passQr } from './pass-qr.ts';
import { DEMO_QR_TOKEN, DEMO_ROSTER, DEMO_VOLUNTEER_TEAM } from './roster.ts';

import {
  BAND_COLOURS,
  BAND_WORDS,
  PASS_TOKEN_WINDOWS,
  PASS_WINDOW_MS,
  REDEEMABLE_ITEMS,
  VOLUNTEER_ONLY_ITEMS,
  isRedemptionItem,
} from '../../../constants/pass.ts';
import {
  isValidNickname,
  normaliseNickname,
} from '../../../constants/nickname.ts';
import { QR_TOKEN_PATTERN } from '../../../constants/qr-token.ts';
import { isValidTicketCode } from '../../../constants/ticket.ts';
import { firstName, maskName, maskPhone } from '../../../shared/utils/mask.ts';

import type { RosterEntry } from './roster.ts';
import type { HandlerName } from './routes.ts';
import type { RedemptionItem } from '../../../constants/pass.ts';
import type { AppErrorCode } from '../../../types/appErrorCode.ts';
import type { AttendeeProfile } from '../../../types/attendee.ts';
import type {
  CheckinFailedAttempts,
  CheckinProgress,
  CheckinStep,
} from '../../../types/checkin.ts';
import type { ApiErrorDetails } from '../core/api/api.error.ts';
import type {
  AttendeePass,
  AttendeePassItem,
  AttendeePassStatus,
} from '../core/api/api.attendee.ts';
import type {
  CheckinApiResponse,
  CheckinSessionView,
} from '../core/api/api.types.ts';
import type {
  RaffleDraw,
  RaffleDrawResult,
  RaffleView,
} from '../core/api/api.raffle.ts';
import type {
  RedeemResult,
  ReviewView,
  ServedItem,
  StaffBand,
} from '../core/api/api.staff.ts';

/** What the demo remembers about one attendee beyond their registration. */
export interface AttendeeRecord {
  /** Null until checked in, and for volunteers, who are never numbered. */
  checkinNumber: number | null;

  /** ISO timestamp, or null while not checked in. */
  checkinAt: string | null;

  nickname: string | null;

  /** ISO timestamp per collected item. */
  redeemedAt: Partial<Record<RedemptionItem, string>>;

  surveyCompleted: boolean;
}

/** A check-in in progress: the server's `checkin` session. */
export interface CheckinFlow {
  ticketCode: string | null;
  progress: CheckinProgress;
  failedAttempts: CheckinFailedAttempts;
  captchaRequired: boolean;
}

/** Everything the demo remembers, as plain JSON. */
export interface DemoState {
  version: 1;

  /** Keyed by ticket code. */
  records: Record<string, AttendeeRecord>;

  checkin: CheckinFlow;

  /** The signed-in attendee, once a check-in has completed. */
  session: { ticketCode: string } | null;

  /** The number the next participant to check in receives. */
  nextCheckinNumber: number;

  /** Raffle draws not put back, newest first. */
  draws: RaffleDraw[];

  /** Idempotency key to the draw it produced. */
  drawKeys: Record<string, string>;
}

/** What a handler is given besides the state. */
export interface DemoRequest {
  /** The parsed JSON body, or `undefined` when there was none. */
  body: unknown;

  /** Header names in lower case. */
  headers: Readonly<Record<string, string>>;

  /** Epoch milliseconds. */
  now: number;

  /** Uniform in `[0, 1)`, like `Math.random`. */
  random: () => number;

  /** A fresh UUID. */
  uuid: () => string;
}

/** What a handler answers: the next state and the response to send. */
export interface DemoResult {
  state: DemoState;
  status: number;

  /** Absent for a response with no body. */
  body?: unknown;
}

/** One endpoint. */
export type Handler = (state: DemoState, req: DemoRequest) => DemoResult;

/** The `AttendeeProfile` the pass page is rendered with, as JSON. */
export type PassProfile = {
  [K in keyof AttendeeProfile]: AttendeeProfile[K] extends Date | null
    ? string | null
    : AttendeeProfile[K];
};

/** Failures per step before the session requires a captcha, as in production. */
const LOCKOUT_THRESHOLDS: Record<keyof CheckinFailedAttempts, number> = {
  ticket: 5,
  verification: 5,
  qr: 10,
};

/** Items in the order the pass and the staff card list them. */
const ITEM_ORDER: readonly RedemptionItem[] = [
  'tshirt_volunteer',
  'lunch',
  'tshirt',
  'meal',
  'drink',
];

const DRAW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REVIEW_HANDLE_PATTERN = /^review-([a-z0-9]{6})$/;

/* -------------------------------------------------------------------------- */
/* roster                                                                      */
/* -------------------------------------------------------------------------- */

const ROSTER_BY_CODE: ReadonlyMap<string, RosterEntry> = new Map(
  DEMO_ROSTER.map((entry) => [entry.code, entry]),
);

/** The registered attendee holding `code`, if any. */
const registered = (code: string): RosterEntry | undefined =>
  ROSTER_BY_CODE.get(code);

/** What an attendee registered for one item, or `null` for no entitlement. */
const entitlement = (
  person: RosterEntry,
  item: RedemptionItem,
): string | null => {
  switch (item) {
    case 'tshirt_volunteer':
      return person.tshirtVolunteerSize;
    case 'lunch':
      return person.lunchOption;
    case 'tshirt':
      return person.tshirtSize;
    case 'meal':
      return person.mealOption;
    case 'drink':
      return person.drinkOption;
  }
};

/* -------------------------------------------------------------------------- */
/* state                                                                       */
/* -------------------------------------------------------------------------- */

/** A check-in with nothing done yet. */
const blankFlow = (captchaRequired = false): CheckinFlow => ({
  ticketCode: null,
  progress: { ticket: false, verified: false, qr: false },
  failedAttempts: { ticket: 0, verification: 0, qr: 0 },
  captchaRequired,
});

/**
 * The state a new visitor starts from.
 *
 * Attendees marked `checkedIn` in the roster arrive already numbered, in
 * roster order and a few minutes apart, so the raffle has a pool before the
 * visitor does anything.
 *
 * @param now - Epoch milliseconds the arrivals are counted back from.
 */
export const createInitialState = (now: number): DemoState => {
  const records: Record<string, AttendeeRecord> = {};
  let next = 1;
  const arrived = DEMO_ROSTER.filter((entry) => entry.checkedIn).length;
  let seen = 0;

  for (const entry of DEMO_ROSTER) {
    const record: AttendeeRecord = {
      checkinNumber: null,
      checkinAt: null,
      nickname: null,
      redeemedAt: {},
      surveyCompleted: false,
    };

    if (entry.checkedIn) {
      record.checkinAt = new Date(
        now - (arrived - seen) * 6 * 60_000,
      ).toISOString();
      seen += 1;

      if (entry.role === 'participant') {
        record.checkinNumber = next;
        next += 1;
      }
    }

    records[entry.code] = record;
  }

  return {
    version: 1,
    records,
    checkin: blankFlow(),
    session: null,
    nextCheckinNumber: next,
    draws: [],
    drawKeys: {},
  };
};

/* -------------------------------------------------------------------------- */
/* responses                                                                   */
/* -------------------------------------------------------------------------- */

/** A 200 with the production envelope around `data`. */
const success = (
  state: DemoState,
  code: string,
  data?: unknown,
  status = 200,
): DemoResult => ({
  state,
  status,
  body: { success: true, code, ...(data === undefined ? {} : { data }) },
});

/** An error in the backend's envelope, as `errorHandler` serialises it. */
const fail = (
  state: DemoState,
  status: number,
  code: AppErrorCode,
  message: string,
  details?: ApiErrorDetails,
): DemoResult => ({
  state,
  status,
  body: {
    success: false,
    error: message,
    code,
    ...(details === undefined ? {} : { details }),
  },
});

const unauthorized = (state: DemoState): DemoResult =>
  fail(state, 401, 'UNAUTHORIZED', 'Unauthorized');

/**
 * The refusal for everything the demo does not do.
 *
 * `FORBIDDEN` because its client copy across the admin screens reads as a
 * permission the operator lacks ("Você não tem mais permissão para …"), which
 * is true to a read-only demo, whereas `SERVICE_UNAVAILABLE` would invite a
 * retry that can never work. Phase 4's notice replaces the wording; the single
 * status and code stay here.
 */
export const refuse: Handler = (state) =>
  fail(state, 403, 'FORBIDDEN', 'Disabled in the demo');

/** Reads a string member of a JSON body. */
const stringField = (body: unknown, key: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;

  const value = (body as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : undefined;
};

/* -------------------------------------------------------------------------- */
/* check-in                                                                    */
/* -------------------------------------------------------------------------- */

/** The step the flow is waiting on. */
const nextStepOf = ({ ticket, verified, qr }: CheckinProgress): CheckinStep => {
  if (!ticket) return 'ticket';
  if (!verified) return 'verification';
  if (!qr) return 'qr';

  return 'success';
};

/** The part of the flow the browser may see. */
const sessionView = (flow: CheckinFlow): CheckinSessionView => {
  const person =
    flow.ticketCode === null ? undefined : registered(flow.ticketCode);

  return {
    progress: flow.progress,
    attendeePreview: person
      ? {
          ticketCode: person.code,
          name: maskName(person.name),
          phoneStart: maskPhone(person.phone),
        }
      : {},
    attendeeRole: person?.role ?? null,
  };
};

/**
 * The envelope every check-in endpoint answers with.
 *
 * @param flow - The flow the answer is about. Not always the state's own: a
 *   completed check-in is answered as complete, though its flow is discarded.
 */
const flowResponse = (
  state: DemoState,
  flow: CheckinFlow,
  code: string,
  session?: CheckinSessionView,
): DemoResult => {
  const response: CheckinApiResponse = {
    success: true,
    code,
    meta: {
      nextStep: nextStepOf(flow.progress),
      captchaRequired: flow.captchaRequired,
    },
    data: session ? { session } : {},
  };

  return { state, status: 200, body: response };
};

/**
 * The initial payload the check-in page is rendered with.
 *
 * The server draws it from the visitor's session; with no session in a static
 * page, the mock writes it in before the page script reads it.
 *
 * @param state - Current state.
 */
export const checkinPageData = (state: DemoState): CheckinApiResponse => {
  const { checkin } = state;
  const started = checkin.progress.ticket;

  return {
    success: true,
    meta: {
      nextStep: nextStepOf(checkin.progress),
      captchaRequired: checkin.captchaRequired,
    },
    data: started ? { session: sessionView(checkin) } : {},
  };
};

/**
 * Requires and clears the captcha when the flow demands one.
 *
 * The production middleware verifies the token with Cloudflare. The demo has
 * no secret key, so any non-empty token counts: the widget is the real one, on
 * Cloudflare's always-pass test key.
 *
 * @returns The state with the requirement cleared, or the refusal.
 */
const passCaptcha = (
  state: DemoState,
  body: unknown,
): { state: DemoState } | { refusal: DemoResult } => {
  if (!state.checkin.captchaRequired) return { state };

  const token = stringField(body, 'captchaToken');

  if (!token) {
    return {
      refusal: fail(
        state,
        400,
        'CAPTCHA_REQUIRED',
        'Captcha verification required',
      ),
    };
  }

  return {
    state: {
      ...state,
      checkin: {
        ...state.checkin,
        captchaRequired: false,
        failedAttempts: { ticket: 0, verification: 0, qr: 0 },
      },
    },
  };
};

/**
 * Charges a failed attempt to a step and answers the failure.
 *
 * Crossing the step's threshold locks the session: it is replaced by a blank
 * one that requires a captcha, and the answer sends the browser back to the
 * ticket step to solve it.
 */
const failStep = (
  state: DemoState,
  step: keyof CheckinFailedAttempts,
  message: string,
): DemoResult => {
  const failedAttempts = {
    ...state.checkin.failedAttempts,
    [step]: state.checkin.failedAttempts[step] + 1,
  };

  if (failedAttempts[step] >= LOCKOUT_THRESHOLDS[step]) {
    return fail(
      { ...state, checkin: blankFlow(true) },
      400,
      'CAPTCHA_REQUIRED',
      'Too many failed attempts. Please complete the verification.',
      { nextStep: 'ticket', captchaRequired: true },
    );
  }

  return fail(
    { ...state, checkin: { ...state.checkin, failedAttempts } },
    400,
    'VALIDATION_ERROR',
    message,
  );
};

/** Gives the attendee a check-in number the first time and the same one after. */
const completeCheckin = (
  state: DemoState,
  person: RosterEntry,
  now: number,
): { state: DemoState; checkinNumber: number | null } => {
  const record = state.records[person.code];

  if (!record) throw new Error(`No record for ${person.code}`);

  if (record.checkinAt !== null) {
    return { state, checkinNumber: record.checkinNumber };
  }

  const numbered = person.role === 'participant';
  const checkinNumber = numbered ? state.nextCheckinNumber : null;

  return {
    checkinNumber,
    state: {
      ...state,
      nextCheckinNumber: numbered
        ? state.nextCheckinNumber + 1
        : state.nextCheckinNumber,
      records: {
        ...state.records,
        [person.code]: {
          ...record,
          checkinNumber,
          checkinAt: new Date(now).toISOString(),
        },
      },
    },
  };
};

/**
 * Stores a flow and answers for it. A flow with every step cleared completes
 * the check-in, signs the attendee in and discards itself, as the server does.
 */
const persistFlow = (
  state: DemoState,
  flow: CheckinFlow,
  code: string,
  now: number,
): DemoResult => {
  const { progress } = flow;

  if (!(progress.ticket && progress.verified && progress.qr)) {
    return flowResponse(
      { ...state, checkin: flow },
      flow,
      code,
      sessionView(flow),
    );
  }

  const person =
    flow.ticketCode === null ? undefined : registered(flow.ticketCode);

  if (!person) throw new Error('A completed check-in names no attendee');

  const done = completeCheckin(state, person, now);
  const view = { ...sessionView(flow), checkinNumber: done.checkinNumber };

  return flowResponse(
    {
      ...done.state,
      checkin: blankFlow(),
      session: { ticketCode: person.code },
    },
    flow,
    code,
    view,
  );
};

/** Steps that return the session unchanged when already cleared. */
const alreadyDone = (state: DemoState, code: string): DemoResult =>
  flowResponse(state, state.checkin, code, sessionView(state.checkin));

/** `POST /api/v1/checkin/ticket` */
export const submitTicket: Handler = (start, req) => {
  const gate = passCaptcha(start, req.body);

  if ('refusal' in gate) return gate.refusal;

  const { state } = gate;

  if (state.checkin.progress.ticket)
    return alreadyDone(state, 'TICKET_VALIDATED');

  const ticket = stringField(req.body, 'ticket') ?? '';
  const person = isValidTicketCode(ticket) ? registered(ticket) : undefined;

  if (!person) return failStep(state, 'ticket', 'Invalid ticket code');

  // Someone already checked in has no scan left to do.
  const arrived = (state.records[person.code]?.checkinAt ?? null) !== null;

  return persistFlow(
    state,
    {
      ...state.checkin,
      ticketCode: person.code,
      progress: { ticket: true, verified: false, qr: arrived },
    },
    'TICKET_VALIDATED',
    req.now,
  );
};

/** `POST /api/v1/checkin/verification` */
export const submitVerification: Handler = (start, req) => {
  const gate = passCaptcha(start, req.body);

  if ('refusal' in gate) return gate.refusal;

  const { state } = gate;
  const { checkin } = state;

  if (checkin.progress.verified) return alreadyDone(state, 'ATTENDEE_VERIFIED');

  const person =
    checkin.ticketCode === null ? undefined : registered(checkin.ticketCode);
  const submitted = stringField(req.body, 'verificationCode') ?? '';

  if (
    !person ||
    !/^[0-9]{4}$/.test(submitted) ||
    submitted !== person.phone.slice(-4)
  ) {
    return failStep(state, 'verification', 'Invalid verification code');
  }

  return persistFlow(
    state,
    { ...checkin, progress: { ...checkin.progress, verified: true } },
    'ATTENDEE_VERIFIED',
    req.now,
  );
};

/** The token inside a scanned payload: a URL's `k` parameter, or the payload. */
const extractQrToken = (payload: string): string | null => {
  if (!payload) return null;

  try {
    const token = new URL(payload).searchParams.get('k');

    return token === '' ? null : token;
  } catch {
    return payload;
  }
};

/** `POST /api/v1/checkin/qr` */
export const submitQrCode: Handler = (start, req) => {
  const gate = passCaptcha(start, req.body);

  if ('refusal' in gate) return gate.refusal;

  const { state } = gate;
  const { checkin } = state;

  if (checkin.progress.qr) return alreadyDone(state, 'QR_PROCESSED');

  if (!checkin.progress.verified) return unauthorized(state);

  const token = extractQrToken(stringField(req.body, 'qrCode') ?? '');

  if (
    token === null ||
    !QR_TOKEN_PATTERN.test(token) ||
    token !== DEMO_QR_TOKEN
  ) {
    return failStep(state, 'qr', 'Invalid QR token');
  }

  return persistFlow(
    state,
    { ...checkin, progress: { ...checkin.progress, qr: true } },
    'QR_PROCESSED',
    req.now,
  );
};

/**
 * `POST /api/v1/checkin/presence`
 *
 * Production answers `NOT_MARKED_PRESENT` until a volunteer confirms the
 * attendee in the administrator screens. Those are read-only here and a visitor
 * has one device, so the demo confirms at once.
 */
export const checkPresence: Handler = (start, req) => {
  const gate = passCaptcha(start, req.body);

  if ('refusal' in gate) return gate.refusal;

  const { state } = gate;
  const { checkin } = state;

  if (checkin.progress.qr) return alreadyDone(state, 'PRESENCE_CONFIRMED');

  if (!checkin.progress.verified) return unauthorized(state);

  return persistFlow(
    state,
    { ...checkin, progress: { ...checkin.progress, qr: true } },
    'PRESENCE_CONFIRMED',
    req.now,
  );
};

/** `POST /api/v1/checkin/reset` */
export const resetCheckin: Handler = (start, req) => {
  const gate = passCaptcha(start, req.body);

  if ('refusal' in gate) return gate.refusal;

  const { state } = gate;

  const flow = blankFlow(state.checkin.captchaRequired);

  return flowResponse({ ...state, checkin: flow }, flow, 'CHECKIN_RESET');
};

/* -------------------------------------------------------------------------- */
/* the pass                                                                    */
/* -------------------------------------------------------------------------- */

/** The signed-in attendee, or nothing. */
const signedIn = (
  state: DemoState,
): { person: RosterEntry; record: AttendeeRecord } | undefined => {
  if (!state.session) return undefined;

  const person = registered(state.session.ticketCode);
  const record = state.records[state.session.ticketCode];

  return person && record ? { person, record } : undefined;
};

/**
 * Which page of the demo the visitor belongs on.
 *
 * @returns `'participant'` or `'volunteer'` for a signed-in attendee, `null`
 *   for a visitor who has not checked in.
 */
export const sessionRole = (state: DemoState): RosterEntry['role'] | null =>
  signedIn(state)?.person.role ?? null;

/** The band for a window. A hash of the index, since there is no secret to derive from. */
const bandOf = (window: number): { colour: string; word: string } => {
  let h = Math.imul(window + 0x9e3779b9, 0x85ebca6b);

  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;

  return {
    colour: BAND_COLOURS[h & 7] ?? BAND_COLOURS[0],
    word: BAND_WORDS[(h >>> 3) & 31] ?? BAND_WORDS[0],
  };
};

const windowOf = (now: number): number => Math.floor(now / PASS_WINDOW_MS);

const expiresInMs = (now: number): number =>
  (windowOf(now) + 1) * PASS_WINDOW_MS - now;

/** The redemption slots of one attendee, in display order. */
const itemsOf = (
  person: RosterEntry,
  record: AttendeeRecord,
): AttendeePassItem[] =>
  ITEM_ORDER.map((item) => ({
    item,
    value: entitlement(person, item),
    redeemedAt: record.redeemedAt[item] ?? null,
  }));

const statusOf = (
  person: RosterEntry,
  record: AttendeeRecord,
): Required<Omit<AttendeePassStatus, 'welcomeText'>> => ({
  items: itemsOf(person, record),
  survey: { open: true, completed: record.surveyCompleted },
  accessTier: person.accessTier,
  welcome: record.surveyCompleted ? 'thanks' : 'arrival',
});

const passOf = (
  person: RosterEntry,
  record: AttendeeRecord,
  now: number,
): AttendeePass => {
  const token = `demo.${person.code}.${String(windowOf(now))}`;

  return {
    band: bandOf(windowOf(now)),
    token,
    qr: passQr(token),
    expiresInMs: expiresInMs(now),
    ...statusOf(person, record),
  };
};

const profileOf = (
  person: RosterEntry,
  record: AttendeeRecord,
): PassProfile => {
  const volunteer = person.role === 'volunteer';
  const at = (item: RedemptionItem): string | null =>
    record.redeemedAt[item] ?? null;

  return {
    ticketCode: person.code,
    attendeeFirstName: firstName(person.name),
    attendeeNickname: record.nickname,
    checkinNumber: record.checkinNumber,
    checkinAt: record.checkinAt,
    attendeeRole: person.role,
    canRedeem: person.canRedeem,
    canDraw: person.canDraw,
    showAdminLink: person.showAdminLink,
    accessTier: person.accessTier,
    team: volunteer ? DEMO_VOLUNTEER_TEAM.team : null,
    teamRole: volunteer ? DEMO_VOLUNTEER_TEAM.teamRole : null,
    mealOption: person.mealOption,
    mealRedeemedAt: at('meal'),
    drinkOption: person.drinkOption,
    drinkRedeemedAt: at('drink'),
    tshirtSize: person.tshirtSize,
    tshirtRedeemedAt: at('tshirt'),
    lunchOption: person.lunchOption,
    lunchRedeemedAt: at('lunch'),
    tshirtVolunteerSize: person.tshirtVolunteerSize,
    tshirtVolunteerRedeemedAt: at('tshirt_volunteer'),
    surveyCompleted: record.surveyCompleted,
  };
};

/**
 * The initial payload the pass page is rendered with: the profile and the
 * first pass.
 *
 * @param state - Current state.
 * @param now - Epoch milliseconds.
 * @returns The payload, or `null` when nobody is signed in.
 */
export const passPageData = (
  state: DemoState,
  now: number,
): { data: { profile: PassProfile; pass: AttendeePass } } | null => {
  const current = signedIn(state);

  if (!current) return null;

  const { person, record } = current;

  return {
    data: {
      profile: profileOf(person, record),
      pass: passOf(person, record, now),
    },
  };
};

/** `GET /api/v1/attendee/pass` */
export const getPass: Handler = (state, req) => {
  const current = signedIn(state);

  return current
    ? success(
        state,
        'PASS_ISSUED',
        passOf(current.person, current.record, req.now),
      )
    : unauthorized(state);
};

/** `GET /api/v1/attendee/status` */
export const getStatus: Handler = (state) => {
  const current = signedIn(state);

  return current
    ? success(state, 'PASS_STATUS', statusOf(current.person, current.record))
    : unauthorized(state);
};

/** `PATCH /api/v1/attendee/nickname` */
export const setNickname: Handler = (state, req) => {
  const current = signedIn(state);

  if (!current) return unauthorized(state);

  const raw = stringField(req.body, 'nickname');

  if (raw === undefined) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid nickname');
  }

  const value = normaliseNickname(raw);

  if (value !== '' && !isValidNickname(value)) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid nickname');
  }

  const nickname = value === '' ? null : value;

  return success(
    {
      ...state,
      records: {
        ...state.records,
        [current.person.code]: { ...current.record, nickname },
      },
    },
    'NICKNAME_UPDATED',
    { nickname },
  );
};

/** `POST /api/v1/attendee/logout` */
export const logout: Handler = (state) => ({
  state: { ...state, session: null },
  status: 204,
});

/** `POST /api/v1/survey`; the answers are accepted and discarded. */
export const submitSurvey: Handler = (state, req) => {
  const current = signedIn(state);

  if (!current) return unauthorized(state);

  if (stringField(req.body, 'structureVersion') === undefined) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid answers');
  }

  if (current.record.surveyCompleted) {
    return fail(state, 409, 'SURVEY_ANSWERED', 'Survey already answered');
  }

  return success(
    {
      ...state,
      records: {
        ...state.records,
        [current.person.code]: { ...current.record, surveyCompleted: true },
      },
    },
    'SURVEY_RECORDED',
    undefined,
    201,
  );
};

/* -------------------------------------------------------------------------- */
/* staff                                                                       */
/* -------------------------------------------------------------------------- */

/** `GET /api/v1/staff/band` */
export const getStaffBand: Handler = (state, req) => {
  const data: StaffBand = {
    band: bandOf(windowOf(req.now)),
    expiresInMs: expiresInMs(req.now),
  };

  return success(state, 'BAND_ISSUED', data);
};

/**
 * Opens a review of an attendee.
 *
 * A participant is named by their check-in number, a volunteer by first name.
 * Every item is in the volunteer's scope: the demo has one counter.
 */
const openReview = (state: DemoState, person: RosterEntry): DemoResult => {
  const record = state.records[person.code];

  if (!record) return fail(state, 404, 'NOT_FOUND', 'Attendee not found');

  if (person.role === 'participant' && record.checkinNumber === null) {
    return fail(state, 404, 'NOT_FOUND', 'Attendee record is incomplete');
  }

  const items: ServedItem[] = ITEM_ORDER.filter(
    (item) =>
      !VOLUNTEER_ONLY_ITEMS.includes(item) || person.role === 'volunteer',
  ).map((item) => ({
    item,
    label: REDEEMABLE_ITEMS[item],
    value: entitlement(person, item),
    redeemedAt: record.redeemedAt[item] ?? null,
    inScope: true,
  }));

  const review: ReviewView = {
    handle: `review-${person.code}`,
    attendeeRole: person.role,
    identifier:
      record.checkinNumber === null
        ? { kind: 'firstName', value: firstName(person.name) }
        : { kind: 'checkinNumber', value: record.checkinNumber },
    items,
  };

  return success(state, 'PASS_VERIFIED', review);
};

/** `POST /api/v1/staff/verify` */
export const verifyPass: Handler = (state, req) => {
  const [prefix, code, window] = (stringField(req.body, 'token') ?? '')
    .trim()
    .split('.');
  const person = prefix === 'demo' && code ? registered(code) : undefined;
  const issued = Number(window);

  if (!person || !Number.isInteger(issued) || issued > windowOf(req.now)) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid pass');
  }

  if (windowOf(req.now) - issued >= PASS_TOKEN_WINDOWS) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Pass expired');
  }

  return openReview(state, person);
};

/** `POST /api/v1/staff/lookup` */
export const lookupAttendee: Handler = (state, req) => {
  const query = (stringField(req.body, 'query') ?? '').trim().toLowerCase();

  if (!isValidTicketCode(query)) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid lookup');
  }

  const person = registered(query);

  return person
    ? openReview(state, person)
    : fail(state, 404, 'NOT_FOUND', 'Attendee not found');
};

/** `POST /api/v1/staff/redeem` */
export const redeemItem: Handler = (state, req) => {
  const code = REVIEW_HANDLE_PATTERN.exec(
    stringField(req.body, 'handle') ?? '',
  )?.[1];
  const person = code === undefined ? undefined : registered(code);
  const record = person && state.records[person.code];
  const item = stringField(req.body, 'item') ?? '';

  if (!isRedemptionItem(item)) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid item');
  }

  if (!person || !record) {
    return fail(state, 404, 'NOT_FOUND', 'Review expired');
  }

  const label = REDEEMABLE_ITEMS[item];
  const collected = record.redeemedAt[item];

  const answer = (
    next: DemoState,
    outcome: RedeemResult['outcome'],
    redeemedAt: string | null,
  ): DemoResult =>
    success(next, 'REDEMPTION_RECORDED', { outcome, item, label, redeemedAt });

  if (entitlement(person, item) === null)
    return answer(state, 'not_entitled', null);

  if (collected !== undefined) return answer(state, 'duplicate', collected);

  const redeemedAt = new Date(req.now).toISOString();

  return answer(
    {
      ...state,
      records: {
        ...state.records,
        [person.code]: {
          ...record,
          redeemedAt: { ...record.redeemedAt, [item]: redeemedAt },
        },
      },
    },
    'redeemed',
    redeemedAt,
  );
};

/* -------------------------------------------------------------------------- */
/* raffle                                                                      */
/* -------------------------------------------------------------------------- */

/** Every check-in number in the draw, ascending: checked-in participants. */
const poolOf = (state: DemoState): number[] =>
  Object.values(state.records)
    .map((record) => record.checkinNumber)
    .filter((number): number is number => number !== null)
    .sort((a, b) => a - b);

/** The pool, the counters and the standing draws. */
export const raffleView = (state: DemoState): RaffleView => {
  const pool = poolOf(state);
  const drawn = new Set(state.draws.map((draw) => draw.checkinNumber));

  return {
    draws: state.draws,
    poolSize: pool.length,
    remaining: pool.filter((number) => !drawn.has(number)).length,
    poolMin: pool[0] ?? 0,
    poolMax: pool[pool.length - 1] ?? 0,
  };
};

/** `GET /api/v1/raffle/draws` */
export const getDraws: Handler = (state) =>
  success(state, 'RAFFLE_DRAWS', raffleView(state));

/** `POST /api/v1/raffle/draw` */
export const drawNumber: Handler = (state, req) => {
  const key = req.headers['idempotency-key'];
  const earlier = key === undefined ? undefined : state.drawKeys[key];
  const repeat = state.draws.find((draw) => draw.drawId === earlier);

  // A re-tap after a timeout shows the number already called.
  if (repeat) {
    const result: RaffleDrawResult = { draw: repeat, ...raffleView(state) };

    return success(state, 'RAFFLE_DRAWN', result);
  }

  const allowRepeats =
    typeof req.body === 'object' &&
    req.body !== null &&
    (req.body as Record<string, unknown>).allowRepeats === true;
  const standing = new Set(state.draws.map((draw) => draw.checkinNumber));
  const candidates = poolOf(state).filter(
    (number) => allowRepeats || !standing.has(number),
  );
  const winner = candidates[Math.floor(req.random() * candidates.length)];

  if (winner === undefined) {
    return fail(state, 409, 'CONFLICT', 'No numbers left to draw');
  }

  const draw: RaffleDraw = {
    drawId: req.uuid(),
    checkinNumber: winner,
    drawnAt: new Date(req.now).toISOString(),
  };
  const next: DemoState = {
    ...state,
    draws: [draw, ...state.draws],
    drawKeys:
      key === undefined
        ? state.drawKeys
        : { ...state.drawKeys, [key]: draw.drawId },
  };
  const result: RaffleDrawResult = { draw, ...raffleView(next) };

  return success(next, 'RAFFLE_DRAWN', result);
};

/** `POST /api/v1/raffle/reset` */
export const resetDraw: Handler = (state, req) => {
  const drawId = stringField(req.body, 'drawId') ?? '';

  if (!DRAW_ID_PATTERN.test(drawId)) {
    return fail(state, 400, 'VALIDATION_ERROR', 'Invalid draw');
  }

  if (!state.draws.some((draw) => draw.drawId === drawId)) {
    return fail(state, 404, 'NOT_FOUND', 'Draw not found');
  }

  const next: DemoState = {
    ...state,
    draws: state.draws.filter((draw) => draw.drawId !== drawId),
  };

  return success(next, 'RAFFLE_RESET', raffleView(next));
};

/* -------------------------------------------------------------------------- */
/* the rest                                                                    */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/client-errors`; reports are dropped. */
export const dropReport: Handler = (state) => ({ state, status: 204 });

/** `GET /api/v1/admin/metrics/snapshot` */
export const getMetricsSnapshot: Handler = (state, req) =>
  success(state, 'METRICS_SNAPSHOT', metricsSnapshot(req.now));

/** Every endpoint's handler, by the name `routes.ts` gives it. */
export const HANDLERS: Record<HandlerName, Handler> = {
  submitTicket,
  submitVerification,
  submitQrCode,
  checkPresence,
  resetCheckin,
  getPass,
  getStatus,
  setNickname,
  logout,
  submitSurvey,
  getStaffBand,
  verifyPass,
  lookupAttendee,
  redeemItem,
  getDraws,
  drawNumber,
  resetDraw,
  dropReport,
  getMetricsSnapshot,
  refuse,
};
