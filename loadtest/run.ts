/**
 * Event-day load test, one phase per run.
 *
 *   k6 run -e PHASE=checkin-participants -e IP_MODE=single run.ts
 *
 * Phases, sized from the event brief at `SCALE=1`:
 *
 * - `checkin-volunteers`: 200 volunteers over 20 minutes, earlier in the day.
 * - `checkin-participants`: 500 over 30 minutes, three times the average rate
 *   from minute 5 to minute 15. Some arrive by entry link, some type the
 *   ticket, and a few mistype it once.
 * - `redemptions`: ten counters at six redemptions a minute each, for 20
 *   minutes, while the queue's passes poll, the counters' bands poll, and a
 *   third of the room polls its pass front.
 * - `raffle`: three draws, three minutes apart. After each, most of the room
 *   opens its pass within a minute to check the number. The whole room polls
 *   its pass front throughout.
 * - `survey`: 500 answers in five minutes, front-loaded on the announcement,
 *   while the whole room polls its pass front.
 *
 * Phases after check-in need checked-in attendees; `setup()` checks them in
 * from addresses of their own before the measured run starts. Reset the stack
 * between runs — docs/performance/load-testing.md.
 */

import exec from 'k6/execution';
import { sleep } from 'k6';

import { Person } from './lib/client.ts';
import {
  drawers,
  participants,
  redeemers,
  settings,
  volunteers,
} from './lib/config.ts';
import {
  answerSurvey,
  attempt,
  checkin,
  draw,
  mintSessions,
  openPass,
  pollBand,
  pollPass,
  pollStatus,
  redeem,
} from './lib/flows.ts';
import { ipFor } from './lib/ip.ts';

import type { Options, Scenario } from 'k6/options';
import type { Attendee } from './lib/config.ts';
import type { RedemptionItemName } from './lib/flows.ts';

type Phase =
  | 'checkin-volunteers'
  | 'checkin-participants'
  | 'redemptions'
  | 'raffle'
  | 'survey';

/** Session IDs minted by `setup()`, in roster order. */
interface Sessions {
  readonly participants: readonly string[];
  readonly redeemers: readonly string[];
  readonly drawers: readonly string[];
}

/**
 * One pass-window: the pass back, the pass front and the volunteer band all
 * poll on it.
 */
const POLL_SECONDS = 30;

/** People waiting in the redemption queues at once: ten counters, six deep. */
const QUEUE_DEPTH = 60;

/** Participants in the room at `SCALE=1`. */
const ROOM = 500;

/**
 * Phones with the pass open on its front at `SCALE=1`, per phase: a third of
 * the room during redemptions, all of it during the raffle and the survey.
 */
const FRONT_PHONES: Partial<Record<Phase, number>> = {
  redemptions: Math.ceil(ROOM / 3),
  raffle: ROOM,
  survey: ROOM,
};

/** Minutes between raffle draws. */
const DRAW_GAP_MINUTES = 3;

const DRAWS = 3;

/** Sessions `setup()` mints for a smoke run. */
const SMOKE_SESSIONS = 3;

/**
 * Items the redemption scenario cycles. Lunch is left out: it is redeemed
 * against participants, who never hold it, so every attempt would be
 * `not_entitled`.
 */
const ITEMS: readonly RedemptionItemName[] = ['tshirt', 'meal', 'drink'];

const s = settings.scale;

/**
 * Scales a stage list's targets by `SCALE`.
 *
 * @param stages - Duration and arrivals per time unit.
 */
const scaled = (stages: readonly [string, number][]) =>
  stages.map(([duration, target]) => ({ duration, target: target * s }));

/**
 * Phones sitting on the front of their pass, each polling its status once a
 * window.
 *
 * An arrival rate rather than one VU per phone: the load is the same, but a
 * healthy run needs a handful of VUs where one per phone meant 10,000 at
 * `SCALE=20`. `maxVUs` is that old count, reached only if polls stall.
 *
 * @param at - The phase, whose {@link FRONT_PHONES} sets the rate.
 * @param duration - How long the phones stay on the front.
 */
const fronts = (at: Phase, duration: string): Scenario => {
  const phones = Math.ceil((FRONT_PHONES[at] ?? 0) * s);

  return {
    executor: 'constant-arrival-rate',
    rate: phones,
    timeUnit: `${String(POLL_SECONDS)}s`,
    duration,
    preAllocatedVUs: Math.max(20, Math.ceil(phones / POLL_SECONDS)),
    maxVUs: phones,
    exec: 'front',
  };
};

/** From the first draw to the end of the last look window. */
const RAFFLE_SECONDS = (DRAWS - 1) * DRAW_GAP_MINUTES * 60 + 65;

const raffleScenarios = (): Record<string, Scenario> => {
  const entries: [string, Scenario][] = [];

  for (let i = 0; i < DRAWS; i++) {
    const start = i * DRAW_GAP_MINUTES * 60;

    entries.push(
      [
        `draw_${String(i + 1)}`,
        {
          executor: 'per-vu-iterations',
          vus: 1,
          iterations: 1,
          startTime: `${String(start)}s`,
          exec: 'drawNumber',
        },
      ],
      [
        // About 600 pass views in a minute at SCALE=1: most of the room, some
        // of it twice.
        `look_${String(i + 1)}`,
        {
          executor: 'ramping-arrival-rate',
          startTime: `${String(start + 5)}s`,
          timeUnit: '1s',
          startRate: 0,
          // Two seconds of the peak rate. k6 drops an arrival while it starts
          // a VU mid-burst, and at 50 raffle dropped up to 0.8% of arrivals at
          // SCALE=16 with the server healthy.
          preAllocatedVUs: Math.max(50, 30 * s),
          maxVUs: 600 * s,
          stages: scaled([
            ['20s', 15],
            ['20s', 15],
            ['20s', 0],
          ]),
          exec: 'lookAtPass',
        },
      ],
    );
  }

  entries.push(['fronts', fronts('raffle', `${String(RAFFLE_SECONDS)}s`)]);

  return Object.fromEntries(entries);
};

const SCENARIOS: Record<Phase, Record<string, Scenario>> = {
  'checkin-volunteers': {
    volunteers: {
      executor: 'constant-arrival-rate',
      rate: 10 * s,
      timeUnit: '1m',
      duration: '20m',
      preAllocatedVUs: 5,
      maxVUs: 50 * s,
      exec: 'checkinVolunteer',
    },
  },
  'checkin-participants': {
    // About 510 arrivals: 8 a minute, then 36 a minute from 5 to 15.
    participants: {
      executor: 'ramping-arrival-rate',
      timeUnit: '1m',
      startRate: 0,
      preAllocatedVUs: 20,
      maxVUs: 200 * s,
      stages: scaled([
        ['5m', 8],
        ['1m', 36],
        ['9m', 36],
        ['2m', 8],
        ['13m', 8],
      ]),
      exec: 'checkinParticipant',
    },
  },
  redemptions: {
    counters: {
      executor: 'constant-arrival-rate',
      rate: 60 * s,
      timeUnit: '1m',
      duration: '20m',
      preAllocatedVUs: 10,
      maxVUs: 50 * s,
      exec: 'redemption',
    },
    queue: {
      executor: 'constant-vus',
      vus: QUEUE_DEPTH * s,
      duration: '20m',
      exec: 'queueing',
    },
    bands: {
      executor: 'constant-vus',
      vus: redeemers.length,
      duration: '20m',
      exec: 'band',
    },
    fronts: fronts('redemptions', '20m'),
  },
  raffle: raffleScenarios(),
  // About 520 answers, 180 of them in the first minute.
  survey: {
    submit: {
      executor: 'ramping-arrival-rate',
      timeUnit: '1m',
      startRate: 0,
      preAllocatedVUs: 20,
      maxVUs: 300 * s,
      stages: scaled([
        ['30s', 240],
        ['30s', 240],
        ['2m', 40],
        ['2m', 20],
      ]),
      exec: 'survey',
    },
    fronts: fronts('survey', '5m'),
  },
};

const phase = (__ENV.PHASE ?? '') as Phase;

if (!Object.hasOwn(SCENARIOS, phase)) {
  throw new Error(`PHASE must be one of ${Object.keys(SCENARIOS).join(', ')}`);
}

/** Where a phase's time is spent: the request that does its database work. */
const PHASE_TREND: Partial<Record<Phase, string>> = {
  'checkin-volunteers': 'checkin_complete_duration',
  'checkin-participants': 'checkin_complete_duration',
  survey: 'survey_submit_duration',
};

const trend = PHASE_TREND[phase];

/**
 * A scenario as `SMOKE=true` runs it: one iteration of the same function, so
 * every request sequence is exercised once before any load is put on it.
 *
 * @param scenario - The phase's scenario.
 */
const smoke = (scenario: Scenario): Scenario => ({
  executor: 'per-vu-iterations',
  vus: 1,
  iterations: 1,
  ...(scenario.exec ? { exec: scenario.exec } : {}),
});

export const options: Options = {
  scenarios: Object.fromEntries(
    Object.entries(SCENARIOS[phase]).map(([name, scenario]) => [
      name,
      { ...(settings.smoke ? smoke(scenario) : scenario), tags: { phase } },
    ]),
  ),
  setupTimeout: '10m',
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    rate_limited: ['rate==0'],
    captcha_required: ['count==0'],
    server_errors: ['rate==0'],
    flow_failed: ['rate==0'],
    // Recorded for measured requests only, and never for a shed.
    served_duration: ['p(95)<500', 'p(99)<1500'],
    ...(trend ? { [trend]: ['p(95)<300'] } : {}),
  },
};

/**
 * Checks in whoever the phase needs before it starts.
 */
export function setup(): Sessions {
  const needs = {
    participants:
      phase === 'redemptions' || phase === 'raffle' || phase === 'survey',
    redeemers: phase === 'redemptions',
    drawers: phase === 'raffle',
  };

  // Spread first: a SharedArray supports indexing and iteration, not `map`.
  // A smoke run needs only a handful; every index is taken modulo the list.
  const take = (list: readonly Attendee[]) =>
    [...list].slice(0, settings.smoke ? SMOKE_SESSIONS : undefined);

  return {
    participants: needs.participants ? mintSessions(take(participants)) : [],
    redeemers: needs.redeemers ? mintSessions(take(redeemers)) : [],
    drawers: needs.drawers ? mintSessions(take(drawers)) : [],
  };
}

/** This iteration's number within its scenario, from zero. */
const iteration = (): number => exec.scenario.iterationInTest;

/**
 * Picks a roster entry round-robin, so a `SCALE` above 1 reuses the roster.
 *
 * @param list - The roster to pick from.
 * @param index - A running count.
 */
const pick = <T>(list: readonly T[], index: number): [T, number] => {
  const at = index % list.length;

  return [list[at] as T, at];
};

/**
 * A phone already signed in with a session from `setup()`.
 *
 * @param sessions - Minted session IDs.
 * @param index - Roster index, which also picks the address.
 */
const signedIn = (sessions: readonly string[], index: number): Person => {
  const at = index % sessions.length;
  const person = new Person(ipFor(at), 'load');

  person.useAttendeeSession(sessions[at] ?? '');

  return person;
};

const arrive = (list: typeof participants, flow: string): void => {
  const [attendee, index] = pick(list, iteration());
  const viaLink = Math.random() < settings.linkRate;

  attempt(flow, () => {
    checkin(new Person(ipFor(index), 'load'), attendee, {
      viaLink,
      typo: !viaLink && Math.random() < settings.typoRate,
      codeTypo: Math.random() < settings.codeTypoRate,
    });
  });
};

export function checkinVolunteer(): void {
  arrive(volunteers, 'checkin_volunteer');
}

export function checkinParticipant(): void {
  arrive(participants, 'checkin_participant');
}

/**
 * One counter redemption. Walks every participant before the next item, so a
 * participant's scans land in different pass windows: a pass token is fixed
 * per window and spent by its first verify, so back-to-back scans of one
 * participant would replay it.
 */
export function redemption(data: Sessions): void {
  const n = iteration();
  const counter = n % data.redeemers.length;
  const participant = n % data.participants.length;
  const item = Math.floor(n / data.participants.length) % ITEMS.length;

  attempt('redemption', () => {
    redeem(
      signedIn(data.redeemers, counter),
      signedIn(data.participants, participant),
      ITEMS[item] ?? 'tshirt',
    );
  });
}

export function queueing(data: Sessions): void {
  attempt('pass_poll', () => {
    pollPass(signedIn(data.participants, exec.vu.idInTest));
  });

  sleep(POLL_SECONDS);
}

/**
 * One status poll, from the next phone on the front. Polls go round the
 * phase's front phones in order, so each polls once a window.
 */
export function front(data: Sessions): void {
  const phones = Math.max(1, Math.ceil((FRONT_PHONES[phase] ?? 0) * s));

  attempt('front_poll', () => {
    pollStatus(signedIn(data.participants, iteration() % phones));
  });
}

export function band(data: Sessions): void {
  attempt('band_poll', () => {
    pollBand(signedIn(data.redeemers, exec.vu.idInTest));
  });

  sleep(POLL_SECONDS);
}

export function drawNumber(data: Sessions): void {
  attempt('raffle_draw', () => {
    draw(signedIn(data.drawers, 0));
  });
}

export function lookAtPass(data: Sessions): void {
  attempt('raffle_look', () => {
    openPass(signedIn(data.participants, iteration()));
  });
}

export function survey(data: Sessions): void {
  attempt('survey', () => {
    answerSurvey(signedIn(data.participants, iteration()));
  });
}
