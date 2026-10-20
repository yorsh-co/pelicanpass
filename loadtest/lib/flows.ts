/**
 * The request sequences a real phone makes, one function per job.
 *
 * Each mirrors what the browser client sends for that screen, so a limiter
 * sees the same count of requests per person as it will at the door. A step
 * answered with anything unexpected throws {@link FlowError}; the scenario
 * records that as a failed flow and moves on to the next arrival.
 */

import { Rate, Trend } from 'k6/metrics';

import { FlowError, Person, isShed } from './client.ts';
import { settings } from './config.ts';
import { setupIpFor } from './ip.ts';

import type { Attendee } from './config.ts';

/** Mirrors `REDEEMABLE_ITEMS` in src/constants/pass.ts. */
export type RedemptionItemName =
  'tshirt' | 'tshirt_volunteer' | 'meal' | 'drink' | 'lunch';

/**
 * Share of flows the server broke, tagged by `flow`. A flow cut short by a
 * shed is not one of them; see {@link flowShed}.
 */
export const flowFailed = new Rate('flow_failed');

/**
 * Share of flows cut short because the app shed a step, tagged by `flow`. No
 * threshold: above capacity it is meant to rise.
 */
export const flowShed = new Rate('flow_shed');

/** The request that completes a check-in: the `FOR UPDATE` transaction. */
export const checkinComplete = new Trend('checkin_complete_duration', true);

/** The questionnaire submit: its insert transaction. */
export const surveySubmit = new Trend('survey_submit_duration', true);

type Response = ReturnType<Person['get']>;

/**
 * Throws unless the response has one of the expected statuses.
 *
 * @param step - Names the step in the failure.
 * @param res - The response to check.
 * @param ok - Accepted statuses.
 */
const expect = (
  step: string,
  res: Response,
  ok: readonly number[] = [200],
): Response => {
  if (!ok.includes(res.status)) throw new FlowError(step, res);

  return res;
};

/**
 * Reads a field of a successful API answer's `data`.
 *
 * @param step - Names the step in a failure.
 * @param res - A `{ success, code, data }` answer.
 * @param field - Field of `data`.
 */
const dataField = (step: string, res: Response, field: string): string => {
  const data = (res.json() as { data?: Record<string, unknown> } | null)?.data;
  const value = data?.[field];

  if (typeof value !== 'string')
    throw new FlowError(`${step}: no ${field}`, res);

  return value;
};

/**
 * Reads the step a check-in answer sends the client to next.
 *
 * @param res - A check-in API answer.
 */
const nextStep = (res: Response): unknown =>
  (res.json() as { meta?: { nextStep?: unknown } } | null)?.meta?.nextStep;

/**
 * Runs a flow and records whether it finished, and if not, whether it was shed
 * or failed.
 *
 * @param flow - Tag for `flow_failed` and `flow_shed`.
 * @param body - The flow.
 * @returns Whether it finished.
 */
export const attempt = (flow: string, body: () => void): boolean => {
  try {
    body();
    flowFailed.add(0, { flow });
    flowShed.add(0, { flow });

    return true;
  } catch (err) {
    if (!(err instanceof FlowError)) throw err;

    const wasShed = isShed(err.response);

    flowFailed.add(!wasShed, { flow });
    flowShed.add(wasShed, { flow });

    // Not logged when shed: above capacity that is thousands of lines saying
    // what the `flow_shed` rate already says.
    if (!wasShed) console.warn(`${flow}: ${err.message}`);

    return false;
  }
};

export interface CheckinOptions {
  /** Arrives through the WhatsApp entry link rather than typing the ticket. */
  readonly viaLink: boolean;
  /** Mistypes the ticket once before getting it right. Manual entry only. */
  readonly typo: boolean;
  /** Mistypes the verification code once before getting it right. */
  readonly codeTypo: boolean;
}

/**
 * Checks an attendee in from the entry page to their pass.
 *
 * @param person - The phone.
 * @param attendee - Who is checking in.
 * @param options - How they arrive.
 */
export const checkin = (
  person: Person,
  attendee: Attendee,
  options: CheckinOptions,
): void => {
  if (options.viaLink) {
    // One point for the link, one for the 303 back to the clean URL.
    person.assets(
      expect(
        'entry link',
        person.get(`/checkin?t=${attendee.link}`, '/checkin?t'),
      ),
    );
  } else {
    person.assets(expect('entry page', person.get('/checkin')));

    if (options.typo) {
      // A well-formed code no roster holds, so it reaches the lookup and is
      // charged to the global failure budget like a real typo.
      const wrong = `zz${Math.floor(Math.random() * 36 ** 3)
        .toString(36)
        .padStart(3, '0')}`;

      expect(
        'mistyped ticket',
        person.api('POST', '/api/v1/checkin/ticket', { ticket: wrong }),
        [400, 404, 422],
      );
    }

    expect(
      'ticket',
      person.api('POST', '/api/v1/checkin/ticket', { ticket: attendee.ticket }),
    );
  }

  if (options.codeTypo) {
    // One digit off, as a slip on the keypad is. Charged to the attendee's
    // verification budget and the session's attempt count, not to the global
    // entry-failure budget, which only the entry steps reach.
    const last = Number(attendee.code.slice(-1));
    const wrong = `${attendee.code.slice(0, -1)}${String((last + 1) % 10)}`;

    expect(
      'mistyped code',
      person.api('POST', '/api/v1/checkin/verification', {
        verificationCode: wrong,
      }),
      [400],
    );
  }

  let done = expect(
    'verification',
    person.api('POST', '/api/v1/checkin/verification', {
      verificationCode: attendee.code,
    }),
  );

  // Someone already checked in (a second phone, or a SCALE above 1 reusing
  // the roster) has the QR step marked done, so verification completes the
  // check-in itself. The client follows `nextStep`; so does this.
  if (nextStep(done) === 'qr') {
    done = expect(
      'qr',
      person.api('POST', '/api/v1/checkin/qr', {
        qrCode: `${settings.baseUrl}/checkin?k=${settings.qrToken}`,
      }),
    );
  }

  if (!person.attendeeSession)
    throw new FlowError('qr: no attendee session', done);

  // Setup only needs the session; a real phone lands on its pass.
  if (person.stage === 'setup') return;

  checkinComplete.add(done.timings.duration);
  person.assets(openPass(person));
};

/**
 * Checks attendees in during `setup()` and returns their session IDs, in the
 * order given. Each gets its own address, so this spends no measured budget.
 *
 * @param attendees - Who to check in.
 * @throws {Error} If any check-in fails: a run on a half-ready roster would
 *   measure the wrong thing.
 */
export const mintSessions = (attendees: readonly Attendee[]): string[] =>
  attendees.map((attendee, index) => {
    const person = new Person(setupIpFor(index), 'setup');

    try {
      checkin(person, attendee, {
        viaLink: false,
        typo: false,
        codeTypo: false,
      });
    } catch (err) {
      throw new Error(
        `setup check-in failed for ${attendee.ticket}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    return person.attendeeSession ?? '';
  });

/**
 * Opens the pass page, as someone checking their number would.
 *
 * @param person - A checked-in phone.
 */
export const openPass = (person: Person): Response =>
  expect('pass page', person.get('/'));

/**
 * The pass back's poll: one fresh token per rotation window.
 *
 * @param person - A checked-in phone.
 */
export const pollPass = (person: Person): string =>
  dataField(
    'pass poll',
    expect('pass poll', person.api('GET', '/api/v1/attendee/pass')),
    'token',
  );

/**
 * The pass front's status poll: the chips and the survey card, with no token.
 * Mirrors `ui/front-poll.ts`.
 *
 * @param person - A checked-in phone.
 */
export const pollStatus = (person: Person): void => {
  expect('status poll', person.api('GET', '/api/v1/attendee/status'));
};

/**
 * The volunteer page's band poll, once per rotation window.
 *
 * @param volunteer - A volunteer allowed to redeem.
 */
export const pollBand = (volunteer: Person): void => {
  expect('band poll', volunteer.api('GET', '/api/v1/staff/band'));
};

/**
 * One redemption at a counter: the participant's pass is scanned, reviewed
 * and an item handed over.
 *
 * @param volunteer - A volunteer allowed to redeem.
 * @param participant - The checked-in participant at the counter.
 * @param item - What is handed over.
 */
export const redeem = (
  volunteer: Person,
  participant: Person,
  item: RedemptionItemName,
): void => {
  const token = pollPass(participant);

  const handle = dataField(
    'verify',
    expect('verify', volunteer.api('POST', '/api/v1/staff/verify', { token })),
    'handle',
  );

  expect(
    'redeem',
    volunteer.api('POST', '/api/v1/staff/redeem', { handle, item }),
  );
};

/**
 * One raffle draw, as the stage phone makes it.
 *
 * @param drawer - A volunteer allowed to draw.
 */
export const draw = (drawer: Person): void => {
  expect('draws', drawer.api('GET', '/api/v1/raffle/draws'));
  expect('draw', drawer.api('POST', '/api/v1/raffle/draw', {}));
};

/**
 * Answers the questionnaire the pass page renders, whatever its questions.
 *
 * A second submit from the same attendee (a `SCALE` above 1 reuses the roster)
 * is a `409`, which still runs the insert and is accepted.
 *
 * @param person - A checked-in phone.
 */
export const answerSurvey = (person: Person): void => {
  const page = openPass(person);
  const doc = page.html();

  const structureVersion = doc
    .find('form[data-survey="form"]')
    .attr('data-structure-version');

  if (!structureVersion)
    throw new FlowError('survey: no form on the pass', page);

  const answers: Record<string, number | boolean | string> = {};

  for (const question of doc.find('[data-question-id]').toArray()) {
    const id = question.attr('data-question-id');

    if (!id) continue;

    switch (question.attr('data-type')) {
      case 'rating':
        answers[id] = 8;
        break;
      case 'yes-no':
        answers[id] = true;
        break;
      case 'text':
        answers[id] = 'Teste de carga';
        break;
    }
  }

  const res = expect(
    'survey',
    person.api('POST', '/api/v1/survey', { structureVersion, answers }),
    [201, 409],
  );

  surveySubmit.add(res.timings.duration);
};
