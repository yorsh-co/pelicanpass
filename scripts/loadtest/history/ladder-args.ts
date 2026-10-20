/**
 * Command-line options for `scripts/loadtest/ladder.ts`, parsed and checked
 * before anything touches the stack.
 */

import { parseArgs } from 'node:util';

import { DEFAULT_KNEE_OPTIONS } from './knee.ts';

export const PHASES = [
  'checkin-volunteers',
  'checkin-participants',
  'redemptions',
  'raffle',
  'survey',
] as const;

export type Phase = (typeof PHASES)[number];

/**
 * Survey arrivals at `SCALE=1`: its stages in loadtest/run.ts ramp to 240 a
 * minute over 30 s, hold 30 s, fall to 40 over 2 min and to 20 over 2 more,
 * which is 60 + 120 + 280 + 60.
 */
export const SURVEY_ARRIVALS_PER_SCALE = 520;

/** Participants in the event brief, which every other phase models. */
export const BRIEF_PARTICIPANTS = 500;

/**
 * Participants a rung takes from the roster.
 *
 * Survey needs one per arrival: each answers once, so a reused participant's
 * submit is a `409` that never reaches the database. Raffle needs one per
 * phone: its whole room polls the pass front, and a session shared by several
 * phones would spend `rl:session:attendee` several times over and be refused
 * well below the host's own limit. Every other phase takes the brief's 500,
 * since `setup()` checks in every participant it is given.
 *
 * @param phase - The rung's phase.
 * @param scale - The rung's `SCALE`.
 * @param override - `--participants`, if given.
 */
export const participantsFor = (
  phase: Phase,
  scale: number,
  override: number | null,
): number => {
  if (override !== null) return override;
  if (phase === 'survey') return Math.ceil(SURVEY_ARRIVALS_PER_SCALE * scale);
  if (phase === 'raffle') return Math.ceil(BRIEF_PARTICIPANTS * scale);

  return BRIEF_PARTICIPANTS;
};

const IP_MODES = ['single', 'cgnat', 'spread'] as const;

/**
 * App settings a rung may override. Each reaches the app as `LOADTEST_<name>`
 * through `compose.loadtest.yml`, which passes nothing else.
 */
export const OVERRIDABLE = [
  'LOAD_SHED_ENABLED',
  'LOAD_SHED_MAX_LAG_MS',
  'LOAD_SHED_MAX_POOL_WAITING',
  'TRUSTED_IPS',
  'RATE_LIMIT_OVERRIDES',
] as const;

/**
 * k6 settings a rung may change from their defaults (docs/performance/load-testing.md).
 * `PHASE`, `IP_MODE`, `SCALE`, `PARTICIPANTS` and `SMOKE` have options of
 * their own.
 */
export const K6_OVERRIDABLE = [
  'TYPO_RATE',
  'CODE_TYPO_RATE',
  'LINK_RATE',
  'WIFI_SHARE',
  'CARRIER_IPS',
  'ASSETS',
] as const;

export interface LadderOptions {
  host: string;
  phase: Phase;
  /** Scales to run in order, or `null` to find the knee. */
  scales: number[] | null;
  ipMode: (typeof IP_MODES)[number];
  maxScale: number;
  smoke: boolean;
  build: boolean;
  appCpuset: string | null;
  note: string | null;
  /** Participants every rung takes, or `null` for {@link participantsFor}. */
  participants: number | null;
  /** Environment for `docker compose`, as `LOADTEST_*` variables. */
  composeEnv: Record<string, string>;
  /** k6 settings changed from their defaults, passed as `-e NAME=value`. */
  k6Env: Record<string, string>;
}

export const USAGE = `Usage: node scripts/loadtest/ladder.ts --host <label> --phase <phase> (--find-knee | --scales <n,n,...>)
  [--shedding on|off] [--env NAME=value ...] [--k6-env NAME=value ...] [--ip-mode spread|cgnat|single]
  [--max-scale <n>] [--app-cpuset <cpus>] [--participants <n>] [--note <text>] [--smoke] [--no-build]

Phases: ${PHASES.join(', ')}
--env accepts: ${OVERRIDABLE.join(', ')}
--k6-env accepts: ${K6_OVERRIDABLE.join(', ')}`;

const isOneOf = <T extends string>(
  values: readonly T[],
  value: string,
): value is T => (values as readonly string[]).includes(value);

/**
 * Parses the runner's arguments.
 *
 * @param argv - Arguments after the script path.
 * @throws {Error} With a message fit for the operator, on anything invalid.
 */
export const parseLadderArgs = (argv: readonly string[]): LadderOptions => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      host: { type: 'string' },
      phase: { type: 'string' },
      'find-knee': { type: 'boolean', default: false },
      scales: { type: 'string' },
      shedding: { type: 'string', default: 'on' },
      env: { type: 'string', multiple: true, default: [] },
      'k6-env': { type: 'string', multiple: true, default: [] },
      'ip-mode': { type: 'string', default: 'spread' },
      'max-scale': {
        type: 'string',
        default: String(DEFAULT_KNEE_OPTIONS.maxScale),
      },
      'app-cpuset': { type: 'string' },
      participants: { type: 'string' },
      note: { type: 'string' },
      smoke: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const host = values.host ?? '';

  if (!/^[a-z0-9][a-z0-9-]*$/.test(host)) {
    throw new Error(
      '--host is required: lower-case letters, digits and dashes, as in "event-host"',
    );
  }

  const phase = values.phase ?? '';

  if (!isOneOf(PHASES, phase)) {
    throw new Error(`--phase must be one of ${PHASES.join(', ')}`);
  }

  if (values['find-knee'] === (values.scales !== undefined)) {
    throw new Error('Give exactly one of --find-knee and --scales');
  }

  if (values.smoke && values['find-knee']) {
    throw new Error(
      '--smoke runs each scenario once, which passes at any SCALE: use it with --scales',
    );
  }

  const maxScale = Number(values['max-scale']);

  if (!Number.isFinite(maxScale) || maxScale <= 0) {
    throw new Error('--max-scale must be a positive number');
  }

  const scales =
    values.scales === undefined
      ? null
      : values.scales.split(',').map((raw) => {
          const scale = Number(raw);

          if (!Number.isFinite(scale) || scale <= 0 || scale > maxScale) {
            throw new Error(
              `--scales: "${raw}" is not a number from above 0 to ${String(maxScale)}`,
            );
          }

          return scale;
        });

  const ipMode = values['ip-mode'];

  if (!isOneOf(IP_MODES, ipMode)) {
    throw new Error(`--ip-mode must be one of ${IP_MODES.join(', ')}`);
  }

  if (values.shedding !== 'on' && values.shedding !== 'off') {
    throw new Error('--shedding must be on or off');
  }

  const participants =
    values.participants === undefined ? null : Number(values.participants);

  if (
    participants !== null &&
    (!Number.isInteger(participants) || participants <= 0)
  ) {
    throw new Error('--participants must be a positive whole number');
  }

  const composeEnv: Record<string, string> = {};

  for (const pair of values.env) {
    const at = pair.indexOf('=');
    const name = at === -1 ? pair : pair.slice(0, at);

    if (at === -1 || !isOneOf(OVERRIDABLE, name)) {
      throw new Error(
        `--env ${pair}: expected NAME=value, NAME one of ${OVERRIDABLE.join(', ')}`,
      );
    }

    composeEnv[`LOADTEST_${name}`] = pair.slice(at + 1);
  }

  const k6Env: Record<string, string> = {};

  for (const pair of values['k6-env']) {
    const at = pair.indexOf('=');
    const name = at === -1 ? pair : pair.slice(0, at);
    const value = pair.slice(at + 1);

    if (at === -1 || !isOneOf(K6_OVERRIDABLE, name)) {
      throw new Error(
        `--k6-env ${pair}: expected NAME=value, NAME one of ${K6_OVERRIDABLE.join(', ')}`,
      );
    }

    // Recorded space-separated in the row, so a value must not hold one.
    if (!/^[\w.:-]+$/.test(value)) {
      throw new Error(
        `--k6-env ${pair}: the value must be letters, digits, dots, colons or dashes`,
      );
    }

    k6Env[name] = value;
  }

  if (values.shedding === 'off') {
    if (composeEnv.LOADTEST_LOAD_SHED_ENABLED === 'true') {
      throw new Error(
        '--shedding off contradicts --env LOAD_SHED_ENABLED=true',
      );
    }

    composeEnv.LOADTEST_LOAD_SHED_ENABLED = 'false';
  }

  return {
    host,
    phase,
    scales,
    ipMode,
    maxScale,
    smoke: values.smoke,
    build: !values['no-build'],
    appCpuset: values['app-cpuset'] ?? null,
    note: values.note ?? null,
    participants,
    composeEnv,
    k6Env,
  };
};

/**
 * The k6 settings a rung changed, as its row records them: `NAME=value`
 * pairs sorted by name, space-separated, or `null` for all defaults.
 *
 * @param k6Env - The rung's `--k6-env` settings.
 */
export const k6EnvLabel = (k6Env: Readonly<Record<string, string>>) => {
  const pairs = Object.entries(k6Env)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`);

  return pairs.length === 0 ? null : pairs.join(' ');
};
