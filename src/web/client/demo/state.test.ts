import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BAND_WORDS } from '../../../constants/pass.ts';
import {
  DEMO_QR_TOKEN,
  DEMO_ROSTER,
  DEMO_VERIFICATION_CODE,
  entryIn,
} from './roster.ts';
import { ROUTES, findRoute, isCovered } from './routes.ts';
import {
  HANDLERS,
  createInitialState,
  passPageData,
  sessionRole,
} from './state.ts';

import type { DemoLocale } from './locale-route.ts';
import type { HandlerName } from './routes.ts';
import type { DemoRequest, DemoResult, DemoState } from './state.ts';
import type { ApiErrorDetails } from '../core/api/api.error.ts';
import type { MetricsSnapshot } from '../core/api/api.admin.metrics.ts';
import type {
  AttendeePass,
  AttendeePassStatus,
} from '../core/api/api.attendee.ts';
import type { CheckinApiResponse } from '../core/api/api.types.ts';
import type { RaffleDrawResult, RaffleView } from '../core/api/api.raffle.ts';
import type {
  RedeemResult,
  ReviewView,
  StaffBand,
} from '../core/api/api.staff.ts';

const NOW = Date.UTC(2026, 9, 17, 14, 30, 0);
const WINDOW_MS = 30_000;

/** A participant who starts unchecked in, and a volunteer likewise. */
const PARTICIPANT = 'k7m2q9';
const VOLUNTEER = 'v2n5r8';

/** A participant who starts checked in, with the first number. */
const ARRIVED = 'a2d5f8';

/** How many participants are checked in at the start. */
const ARRIVED_PARTICIPANTS = DEMO_ROSTER.filter(
  (entry) => entry.checkedIn && entry.role === 'participant',
).length;

/** A response as it travels: the envelope around a typed payload. */
interface Wire<T> {
  success: boolean;
  code: string;
  error: string;
  details?: ApiErrorDetails;
  meta: NonNullable<CheckinApiResponse['meta']>;
  data: T;
}

/** A result whose body is read as {@link Wire}. */
interface Called<T> extends DemoResult {
  body: Wire<T>;
}

type Flow = NonNullable<CheckinApiResponse['data']>;

const request = (
  body: unknown,
  extra: Partial<DemoRequest> = {},
): DemoRequest => ({
  body,
  headers: {},
  now: NOW,
  locale: 'pt-BR',
  random: () => 0,
  uuid: () => '00000000-0000-4000-8000-000000000001',
  ...extra,
});

const call = <T = never>(
  state: DemoState,
  name: HandlerName,
  body?: unknown,
  extra?: Partial<DemoRequest>,
): Called<T> => {
  const result = HANDLERS[name](state, request(body, extra));

  return { ...result, body: result.body as Wire<T> };
};

/** Runs a sequence of calls, threading the state through. */
const run = (
  start: DemoState,
  steps: readonly (readonly [HandlerName, unknown?])[],
): DemoState =>
  steps.reduce((state, [name, body]) => call(state, name, body).state, start);

/** Steps that take `code` from the ticket to a signed-in session. */
const checkInSteps = (
  code: string,
): readonly (readonly [HandlerName, unknown])[] => [
  ['submitTicket', { ticket: code }],
  ['submitVerification', { verificationCode: DEMO_VERIFICATION_CODE }],
  ['checkPresence', {}],
];

const signedIn = (code: string): DemoState =>
  run(createInitialState(NOW), checkInSteps(code));

/** A state with the ticket and verification cleared, waiting on the scan. */
const atScan = (code: string): DemoState =>
  run(createInitialState(NOW), checkInSteps(code).slice(0, 2));

/** Draw ids that differ per call, as the raffle's primary key does. */
const drawId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

describe('roster', () => {
  it('has twenty attendees with distinct, valid codes', () => {
    const codes = DEMO_ROSTER.map((entry) => entry.code);

    assert.equal(codes.length, 20);
    assert.equal(new Set(codes).size, 20);
    assert.ok(codes.every((code) => /^[a-z0-9]{6}$/.test(code)));
  });

  it('ends every phone in the shared verification code', () => {
    assert.ok(
      DEMO_ROSTER.every((entry) =>
        entry.phone.endsWith(DEMO_VERIFICATION_CODE),
      ),
    );
  });

  it('numbers the arrived participants from one, and no volunteer', () => {
    const state = createInitialState(NOW);
    const numbers = DEMO_ROSTER.filter(
      (entry) => entry.checkedIn && entry.role === 'participant',
    ).map((entry) => state.records[entry.code]?.checkinNumber);

    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index + 1),
    );
    assert.equal(state.nextCheckinNumber, ARRIVED_PARTICIPANTS + 1);
    assert.ok(
      DEMO_ROSTER.filter((entry) => entry.role === 'volunteer').every(
        (entry) => state.records[entry.code]?.checkinNumber === null,
      ),
    );
  });
});

/* eslint-disable no-restricted-syntax -- fictional sample data, not interface copy. */
describe('sample data language', () => {
  const profileIn = (code: string, locale: DemoLocale) => {
    const data = passPageData(signedIn(code), NOW, locale);

    assert.ok(data);

    return data.data;
  };

  it('keeps the Portuguese options and team on a pt-BR page', () => {
    const { profile, pass } = profileIn(VOLUNTEER, 'pt-BR');

    assert.equal(profile.team, 'Recepção');
    assert.equal(profile.teamRole, 'Líder');
    assert.equal(profile.mealOption, 'Sem restrição');
    assert.equal(profile.drinkOption, 'Água');
    assert.equal(profile.lunchOption, 'Frango');
    assert.deepEqual(
      pass.items.map((item) => item.value),
      ['M', 'Frango', null, 'Sem restrição', 'Água'],
    );
  });

  it('translates the options and team on an English page', () => {
    const { profile } = profileIn(VOLUNTEER, 'en');

    assert.equal(profile.team, 'Reception');
    assert.equal(profile.teamRole, 'Lead');
    assert.equal(profile.mealOption, 'No restrictions');
    assert.equal(profile.drinkOption, 'Water');
    assert.equal(profile.lunchOption, 'Chicken');
    assert.equal(profileIn(PARTICIPANT, 'en').profile.mealOption, 'Vegetarian');
    assert.equal(
      profileIn(PARTICIPANT, 'en').profile.drinkOption,
      'Orange juice',
    );
  });

  it('has an English wording for every option in the roster', () => {
    for (const person of DEMO_ROSTER) {
      const english = entryIn(person, 'en');

      for (const key of ['mealOption', 'drinkOption', 'lunchOption'] as const) {
        if (person[key] === null) continue;

        assert.notEqual(english[key], person[key], `${person.code} ${key}`);
      }
    }
  });

  it('words the metrics alert in the page language', () => {
    const titleIn = (locale: DemoLocale): string | undefined =>
      call<MetricsSnapshot>(
        createInitialState(NOW),
        'getMetricsSnapshot',
        undefined,
        {
          locale,
        },
      ).body.data.lastAlert?.title;

    assert.equal(titleIn('pt-BR'), 'Fila de check-in acima do normal');
    assert.equal(titleIn('en'), 'Check-in queue above normal');
  });
});
/* eslint-enable no-restricted-syntax */

describe('check-in', () => {
  it('walks ticket, verification and presence to a signed-in pass', () => {
    const start = createInitialState(NOW);

    const ticket = call<Flow>(start, 'submitTicket', { ticket: PARTICIPANT });

    assert.equal(ticket.status, 200);
    assert.equal(ticket.body.meta.nextStep, 'verification');
    assert.equal(
      ticket.body.data.session?.attendeePreview.name,
      'Marina ... T.',
    );
    assert.equal(ticket.body.data.session.attendeeRole, 'participant');

    const verified = call<Flow>(ticket.state, 'submitVerification', {
      verificationCode: DEMO_VERIFICATION_CODE,
    });

    assert.equal(verified.body.meta.nextStep, 'qr');
    assert.equal(sessionRole(verified.state), null);

    const done = call<Flow>(verified.state, 'checkPresence', {});

    assert.equal(done.body.meta.nextStep, 'success');
    assert.equal(
      done.body.data.session?.checkinNumber,
      start.nextCheckinNumber,
    );
    assert.equal(sessionRole(done.state), 'participant');
    assert.equal(done.state.nextCheckinNumber, start.nextCheckinNumber + 1);
    assert.equal(done.state.checkin.progress.ticket, false);
  });

  it('completes with the venue QR token, bare or inside a URL', () => {
    for (const qrCode of [
      DEMO_QR_TOKEN,
      `https://example.test/checkin?k=${DEMO_QR_TOKEN}`,
    ]) {
      const done = call(atScan(PARTICIPANT), 'submitQrCode', { qrCode });

      assert.equal(done.body.meta.nextStep, 'success');
      assert.equal(sessionRole(done.state), 'participant');
    }
  });

  it('refuses a wrong QR token and one scanned before verification', () => {
    const wrong = call(atScan(PARTICIPANT), 'submitQrCode', {
      qrCode: 'NotThisEvent1',
    });

    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'VALIDATION_ERROR');

    const early = call(createInitialState(NOW), 'submitQrCode', {
      qrCode: DEMO_QR_TOKEN,
    });

    assert.equal(early.status, 401);
    assert.equal(early.body.code, 'UNAUTHORIZED');
  });

  it('answers a wrong ticket code as production does', () => {
    for (const ticket of ['zzzzzz', 'abc', '']) {
      const result = call(createInitialState(NOW), 'submitTicket', { ticket });

      assert.equal(result.status, 400);
      assert.equal(result.body.success, false);
      assert.equal(result.body.code, 'VALIDATION_ERROR');
      assert.equal(result.body.error, 'Invalid ticket code');
    }
  });

  it('answers a wrong verification code the same way', () => {
    const ticket = call(createInitialState(NOW), 'submitTicket', {
      ticket: PARTICIPANT,
    });

    for (const verificationCode of ['0000', '12', 'abcd']) {
      const result = call(ticket.state, 'submitVerification', {
        verificationCode,
      });

      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'VALIDATION_ERROR');
      assert.equal(result.body.error, 'Invalid verification code');
    }
  });

  it('locks the flow behind a captcha after five wrong tickets', () => {
    let state = createInitialState(NOW);

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const result = call(state, 'submitTicket', { ticket: 'zzzzzz' });

      assert.equal(result.body.code, 'VALIDATION_ERROR');
      state = result.state;
    }

    const locked = call(state, 'submitTicket', { ticket: 'zzzzzz' });

    assert.equal(locked.status, 400);
    assert.equal(locked.body.code, 'CAPTCHA_REQUIRED');
    assert.deepEqual(locked.body.details, {
      nextStep: 'ticket',
      captchaRequired: true,
    });

    const blocked = call(locked.state, 'submitTicket', { ticket: PARTICIPANT });

    assert.equal(blocked.body.code, 'CAPTCHA_REQUIRED');
    assert.equal(blocked.body.details, undefined);

    const passed = call(blocked.state, 'submitTicket', {
      ticket: PARTICIPANT,
      captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
    });

    assert.equal(passed.status, 200);
    assert.equal(passed.body.meta.captchaRequired, false);
    assert.deepEqual(passed.state.checkin.failedAttempts, {
      ticket: 0,
      verification: 0,
      qr: 0,
    });
  });

  it('keeps the number on a repeat check-in and skips the scan', () => {
    const first = signedIn(PARTICIPANT);
    const number = first.records[PARTICIPANT]?.checkinNumber;
    const out = call(first, 'logout');

    assert.equal(out.status, 204);
    assert.equal(sessionRole(out.state), null);

    const ticket = call(out.state, 'submitTicket', { ticket: PARTICIPANT });

    assert.equal(ticket.body.meta.nextStep, 'verification');

    const verified = call<Flow>(ticket.state, 'submitVerification', {
      verificationCode: DEMO_VERIFICATION_CODE,
    });

    assert.equal(verified.body.meta.nextStep, 'success');
    assert.equal(verified.body.data.session?.checkinNumber, number);
    assert.equal(sessionRole(verified.state), 'participant');
    assert.equal(
      verified.state.nextCheckinNumber,
      first.nextCheckinNumber,
      'no second number issued',
    );
  });

  it('checks in someone who arrived before the visitor', () => {
    const state = signedIn(ARRIVED);

    assert.equal(state.records[ARRIVED]?.checkinNumber, 1);
    assert.equal(state.nextCheckinNumber, ARRIVED_PARTICIPANTS + 1);
  });

  it('numbers a volunteer with nothing', () => {
    const state = signedIn(VOLUNTEER);
    const pass = call<AttendeePass>(state, 'getPass');

    assert.equal(sessionRole(state), 'volunteer');
    assert.equal(state.records[VOLUNTEER]?.checkinNumber, null);
    assert.equal(state.nextCheckinNumber, ARRIVED_PARTICIPANTS + 1);
    assert.equal(pass.body.data.accessTier, 'edit');
  });

  it('returns to the ticket step on reset', () => {
    const ticket = call(createInitialState(NOW), 'submitTicket', {
      ticket: PARTICIPANT,
    });
    const reset = call(ticket.state, 'resetCheckin');

    assert.equal(reset.body.meta.nextStep, 'ticket');
    assert.equal(reset.state.checkin.ticketCode, null);
  });

  it('is idempotent for a step that is already cleared', () => {
    const ticket = call(createInitialState(NOW), 'submitTicket', {
      ticket: PARTICIPANT,
    });
    const again = call(ticket.state, 'submitTicket', { ticket: 'zzzzzz' });

    assert.equal(again.status, 200);
    assert.equal(again.body.meta.nextStep, 'verification');
  });
});

describe('the pass', () => {
  it('refuses every attendee endpoint without a session', () => {
    for (const name of [
      'getPass',
      'getStatus',
      'setNickname',
      'submitSurvey',
    ] as const) {
      const result = call(createInitialState(NOW), name, {
        nickname: 'Mari',
        structureVersion: 'v1',
      });

      assert.equal(result.status, 401, name);
      assert.equal(result.body.code, 'UNAUTHORIZED', name);
    }
  });

  it('issues a complete pass with a band that follows the window', () => {
    const state = signedIn(PARTICIPANT);
    const pass = call<AttendeePass>(state, 'getPass').body.data;

    assert.match(pass.token, /^demo\.k7m2q9\.\d+$/);
    assert.match(pass.qr, /^data:image\/svg\+xml;base64,/);
    assert.deepEqual(
      pass.items.map((entry) => entry.item),
      ['tshirt_volunteer', 'lunch', 'tshirt', 'meal', 'drink'],
    );
    assert.deepEqual(pass.survey, { open: true, completed: false });
    assert.equal(pass.accessTier, null);
    assert.equal(pass.welcome, 'arrival');

    const opened = Math.floor(NOW / WINDOW_MS) * WINDOW_MS;
    const early = call<AttendeePass>(state, 'getPass', undefined, {
      now: opened,
    }).body.data;
    const late = call<AttendeePass>(state, 'getPass', undefined, {
      now: opened + 29_000,
    }).body.data;

    assert.deepEqual(late.band, early.band);
    assert.equal(early.expiresInMs, WINDOW_MS);
    assert.equal(late.expiresInMs, 1_000);
  });

  it('seeds the page with the signed-in profile, or nothing', () => {
    assert.equal(passPageData(createInitialState(NOW), NOW, 'pt-BR'), null);

    const seed = passPageData(signedIn(PARTICIPANT), NOW, 'pt-BR');

    assert.equal(seed?.data.profile.attendeeFirstName, 'Marina');
    assert.equal(seed.data.profile.checkinNumber, ARRIVED_PARTICIPANTS + 1);
    assert.equal(seed.data.pass.items.length, 5);
  });

  it('stores a nickname, normalised, and clears it', () => {
    const state = signedIn(PARTICIPANT);
    const set = call<{ nickname: string | null }>(state, 'setNickname', {
      nickname: '  Mari   Pelicano ',
    });

    assert.equal(set.status, 200);
    assert.equal(set.body.data.nickname, 'Mari Pelicano');
    assert.equal(
      passPageData(set.state, NOW, 'pt-BR')?.data.profile.attendeeNickname,
      'Mari Pelicano',
    );

    const cleared = call<{ nickname: string | null }>(
      set.state,
      'setNickname',
      { nickname: '   ' },
    );

    assert.equal(cleared.body.data.nickname, null);
  });

  it('refuses a nickname that breaks the policy', () => {
    const state = signedIn(PARTICIPANT);

    for (const nickname of ['x', '<script>', '!!!!', 42]) {
      const result = call(state, 'setNickname', { nickname });

      assert.equal(result.status, 400, String(nickname));
      assert.equal(result.body.code, 'VALIDATION_ERROR', String(nickname));
    }
  });

  it('records the survey once', () => {
    const first = call(signedIn(PARTICIPANT), 'submitSurvey', {
      structureVersion: 'v1',
      answers: { q1: 9 },
    });

    assert.equal(first.status, 201);

    const status = call<AttendeePassStatus>(first.state, 'getStatus').body.data;

    assert.deepEqual(status.survey, { open: true, completed: true });
    assert.equal(status.welcome, 'thanks');

    const second = call(first.state, 'submitSurvey', {
      structureVersion: 'v1',
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'SURVEY_ANSWERED');
  });
});

describe('staff', () => {
  it('opens a review from a ticket code and records a redemption', () => {
    const state = signedIn(PARTICIPANT);
    const review = call<ReviewView>(state, 'lookupAttendee', {
      query: ' K7M2Q9 ',
    });

    assert.equal(review.status, 200);
    assert.deepEqual(review.body.data.identifier, {
      kind: 'checkinNumber',
      value: ARRIVED_PARTICIPANTS + 1,
    });
    assert.deepEqual(
      review.body.data.items.map((entry) => entry.item),
      ['tshirt', 'meal', 'drink'],
      'a participant is not shown the volunteer items',
    );

    const redeemed = call<RedeemResult>(review.state, 'redeemItem', {
      handle: review.body.data.handle,
      item: 'tshirt',
    });

    assert.equal(redeemed.body.data.outcome, 'redeemed');
    assert.equal(redeemed.body.data.redeemedAt, new Date(NOW).toISOString());

    const chip = call<AttendeePassStatus>(
      redeemed.state,
      'getStatus',
    ).body.data.items.find((entry) => entry.item === 'tshirt');

    assert.equal(chip?.redeemedAt, new Date(NOW).toISOString());
  });

  it('answers a second redemption as a duplicate', () => {
    const state = signedIn(PARTICIPANT);
    const { handle } = call<ReviewView>(state, 'lookupAttendee', {
      query: PARTICIPANT,
    }).body.data;
    const first = call<RedeemResult>(state, 'redeemItem', {
      handle,
      item: 'meal',
    });
    const second = call<RedeemResult>(first.state, 'redeemItem', {
      handle,
      item: 'meal',
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.data.outcome, 'duplicate');
    assert.equal(second.body.data.redeemedAt, first.body.data.redeemedAt);
  });

  it('answers an item the attendee never held as not entitled', () => {
    const state = signedIn(PARTICIPANT);
    const { handle } = call<ReviewView>(state, 'lookupAttendee', {
      query: PARTICIPANT,
    }).body.data;
    const result = call<RedeemResult>(state, 'redeemItem', {
      handle,
      item: 'lunch',
    });

    assert.equal(result.body.data.outcome, 'not_entitled');
    assert.equal(result.body.data.redeemedAt, null);
  });

  it('names a volunteer by first name and lists every item', () => {
    const review = call<ReviewView>(createInitialState(NOW), 'lookupAttendee', {
      query: 'v6b3k7',
    });

    assert.deepEqual(review.body.data.identifier, {
      kind: 'firstName',
      value: 'Bruno',
    });
    assert.equal(review.body.data.items.length, 5);
  });

  it('refuses unknown, malformed and not-yet-numbered lookups', () => {
    const state = createInitialState(NOW);

    const codes = ['zzzzzz', 'zz', PARTICIPANT].map(
      (query) => call(state, 'lookupAttendee', { query }).body.code,
    );

    assert.deepEqual(codes, ['NOT_FOUND', 'VALIDATION_ERROR', 'NOT_FOUND']);
  });

  it('refuses a redemption with a bad handle or item', () => {
    const state = createInitialState(NOW);

    assert.equal(
      call(state, 'redeemItem', { handle: 'nope', item: 'meal' }).body.code,
      'NOT_FOUND',
    );
    assert.equal(
      call(state, 'redeemItem', { handle: 'review-a2d5f8', item: 'cake' }).body
        .code,
      'VALIDATION_ERROR',
    );
  });

  it('verifies the token printed on a pass, and only while it is fresh', () => {
    const state = signedIn(PARTICIPANT);
    const { token } = call<AttendeePass>(state, 'getPass').body.data;

    const fresh = call<ReviewView>(state, 'verifyPass', { token });

    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.body.data.identifier, {
      kind: 'checkinNumber',
      value: ARRIVED_PARTICIPANTS + 1,
    });

    const stale = call(state, 'verifyPass', { token }, { now: NOW + 90_000 });

    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, 'Pass expired');

    for (const forged of [
      '',
      'demo.zzzzzz.1',
      'other.k7m2q9.1',
      'demo.k7m2q9',
    ]) {
      assert.equal(
        call(state, 'verifyPass', { token: forged }).body.error,
        'Invalid pass',
        forged,
      );
    }
  });

  it('issues the band for the volunteer screen', () => {
    const { data } = call<StaffBand>(
      createInitialState(NOW),
      'getStaffBand',
    ).body;

    assert.ok(data.band.word && data.band.colour);
    assert.ok(data.expiresInMs > 0);
  });

  it('draws the band word from the list for the page language', () => {
    const wordIn = (locale: DemoLocale, now: number): string =>
      call<StaffBand>(createInitialState(now), 'getStaffBand', undefined, {
        locale,
        now,
      }).body.data.band.word;
    const pt: readonly string[] = BAND_WORDS['pt-BR'];
    const en: readonly string[] = BAND_WORDS.en;

    for (let window = 0; window < 64; window += 1) {
      const now = NOW + window * WINDOW_MS;

      assert.ok(pt.includes(wordIn('pt-BR', now)), 'pt-BR');
      assert.ok(en.includes(wordIn('en', now)), 'en');
    }
  });

  it('shows the same word on the pass and the staff screen of one page', () => {
    const state = signedIn(PARTICIPANT);

    for (const locale of ['pt-BR', 'en'] as const) {
      const pass = call<AttendeePass>(state, 'getPass', undefined, { locale });
      const staff = call<StaffBand>(state, 'getStaffBand', undefined, {
        locale,
      });

      assert.deepEqual(pass.body.data.band, staff.body.data.band, locale);
    }
  });

  it('keeps the same position in the list across languages', () => {
    const at = (locale: DemoLocale): string =>
      call<StaffBand>(createInitialState(NOW), 'getStaffBand', undefined, {
        locale,
      }).body.data.band.word;

    const pt: readonly string[] = BAND_WORDS['pt-BR'];
    const en: readonly string[] = BAND_WORDS.en;

    assert.equal(en.indexOf(at('en')), pt.indexOf(at('pt-BR')));
  });
});

describe('raffle', () => {
  it('draws a number from the checked-in pool', () => {
    const result = call<RaffleDrawResult>(signedIn(PARTICIPANT), 'drawNumber', {
      allowRepeats: false,
    });
    const { data } = result.body;

    assert.equal(result.status, 200);
    assert.equal(data.draw.checkinNumber, 1, 'random() = 0 picks the lowest');
    assert.equal(data.poolSize, ARRIVED_PARTICIPANTS + 1);
    assert.equal(data.remaining, ARRIVED_PARTICIPANTS);
    assert.equal(data.poolMin, 1);
    assert.equal(data.poolMax, ARRIVED_PARTICIPANTS + 1);
    assert.deepEqual(result.state.draws, [data.draw]);
  });

  it('draws every number in the pool once and none outside it', () => {
    let state = createInitialState(NOW);
    const seen: number[] = [];

    for (let index = 0; index < ARRIVED_PARTICIPANTS; index += 1) {
      const result = call<RaffleDrawResult>(
        state,
        'drawNumber',
        {},
        { random: () => 0.999, uuid: () => drawId(index) },
      );

      seen.push(result.body.data.draw.checkinNumber);
      state = result.state;
    }

    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      Array.from({ length: ARRIVED_PARTICIPANTS }, (_, index) => index + 1),
    );
  });

  it('answers an empty pool with a conflict', () => {
    const start = createInitialState(NOW);
    const empty: DemoState = {
      ...start,
      records: Object.fromEntries(
        Object.entries(start.records).map(([code, record]) => [
          code,
          { ...record, checkinNumber: null, checkinAt: null },
        ]),
      ),
    };

    const view = call<RaffleView>(empty, 'getDraws').body.data;
    const result = call(empty, 'drawNumber', { allowRepeats: true });

    assert.deepEqual(
      [view.poolSize, view.remaining, view.poolMin, view.poolMax],
      [0, 0, 0, 0],
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CONFLICT');
  });

  it('answers a spent pool with a conflict unless repeats are allowed', () => {
    let state = createInitialState(NOW);

    for (let index = 0; index < ARRIVED_PARTICIPANTS; index += 1) {
      state = call(
        state,
        'drawNumber',
        {},
        { uuid: () => drawId(index) },
      ).state;
    }

    assert.equal(call(state, 'drawNumber', {}).status, 409);
    assert.equal(call<RaffleView>(state, 'getDraws').body.data.remaining, 0);
    assert.equal(call(state, 'drawNumber', { allowRepeats: true }).status, 200);
  });

  it('shows the number already called to a repeated idempotency key', () => {
    const headers = { 'idempotency-key': 'tap-1' };
    const first = call<RaffleDrawResult>(
      createInitialState(NOW),
      'drawNumber',
      {},
      { headers },
    );
    const again = call<RaffleDrawResult>(
      first.state,
      'drawNumber',
      {},
      { headers, random: () => 0.9 },
    );

    assert.deepEqual(again.body.data.draw, first.body.data.draw);
    assert.equal(again.state.draws.length, 1);
  });

  it('puts a number back, and refuses one it does not hold', () => {
    const drawn = call<RaffleDrawResult>(
      createInitialState(NOW),
      'drawNumber',
      {},
    );
    const id = drawn.body.data.draw.drawId;
    const back = call<RaffleView>(drawn.state, 'resetDraw', { drawId: id });

    assert.equal(back.status, 200);
    assert.equal(back.body.data.draws.length, 0);
    assert.equal(back.body.data.remaining, drawn.body.data.remaining + 1);

    assert.equal(
      call(back.state, 'resetDraw', { drawId: id }).body.code,
      'NOT_FOUND',
    );
    assert.equal(
      call(back.state, 'resetDraw', { drawId: 'nope' }).body.code,
      'VALIDATION_ERROR',
    );
  });

  it('counts a visitor who checks in', () => {
    const view = call<RaffleView>(signedIn(PARTICIPANT), 'getDraws').body.data;

    assert.equal(view.poolSize, ARRIVED_PARTICIPANTS + 1);
  });
});

describe('reset', () => {
  it('starts every event from the same state', () => {
    const touched = run(signedIn(PARTICIPANT), [
      ['setNickname', { nickname: 'Mari' }],
      ['submitSurvey', { structureVersion: 'v1' }],
      ['drawNumber', {}],
    ]);
    const fresh = createInitialState(NOW);

    assert.notDeepEqual(touched, fresh);
    assert.equal(sessionRole(fresh), null);
    assert.equal(fresh.draws.length, 0);
    assert.equal(fresh.records[PARTICIPANT]?.checkinNumber, null);
    assert.deepEqual(fresh, createInitialState(NOW));
  });

  it('survives a round trip through JSON, as it does in storage', () => {
    const state = run(signedIn(ARRIVED), [['drawNumber', {}]]);

    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });
});

describe('routes', () => {
  it('finds exact routes and the admin refusal', () => {
    assert.equal(
      findRoute('POST', '/api/v1/checkin/ticket')?.handler,
      'submitTicket',
    );
    assert.equal(
      findRoute('patch', '/api/v1/attendee/nickname')?.handler,
      'setNickname',
    );
    assert.equal(findRoute('GET', '/api/v1/checkin/ticket'), undefined);
    assert.equal(findRoute('GET', '/api/v1/unknown'), undefined);
    assert.equal(
      findRoute('POST', '/api/v1/admin/attendees/7/archive')?.handler,
      'refuse',
    );
  });

  it('answers the metrics snapshot, ahead of the admin refusal', () => {
    assert.equal(
      findRoute('GET', '/api/v1/admin/metrics/snapshot')?.handler,
      'getMetricsSnapshot',
    );

    const result = call<MetricsSnapshot>(
      createInitialState(NOW),
      'getMetricsSnapshot',
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.data.checkins[0]?.checkedIn, 120);
    assert.ok(Object.values(result.body.data.health).every(({ ok }) => ok));
  });

  it('moves the snapshot figures between polls, the same for one instant', () => {
    const at = (now: number): MetricsSnapshot['latency'] =>
      call<MetricsSnapshot>(
        createInitialState(now),
        'getMetricsSnapshot',
        undefined,
        { now },
      ).body.data.latency;

    assert.deepEqual(at(NOW), at(NOW));
    assert.notDeepEqual(at(NOW), at(NOW + 5_000));
  });

  it('routes every administrator write method to the refusal', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.equal(
        findRoute(method, '/api/v1/admin/pass/welcome-schedule')?.handler,
        'refuse',
        method,
      );
    }
  });

  it('refuses admin writes with a permission error, changing nothing', () => {
    const state = createInitialState(NOW);
    const result = call(state, 'refuse', { anything: true });

    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'FORBIDDEN');
    assert.equal(result.state, state);
  });

  it('has a handler for every route and covers wildcard paths', () => {
    assert.ok(ROUTES.every((route) => route.handler in HANDLERS));
    assert.ok(isCovered('/api/v1/admin/redemptions/*/*/*'));
    assert.ok(isCovered('/api/v1/raffle/draw'));
    assert.equal(isCovered('/api/v1/raffle/spin'), false);
  });
});
