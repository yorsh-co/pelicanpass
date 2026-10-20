/**
 * Renders docs/performance/load-test-results.md from the recorded rungs. Deterministic,
 * so a freshness check can compare it byte for byte.
 */

import {
  BASELINE_USERS,
  capacities,
  configurations,
  headlines,
  limiterRuns,
} from './analysis.ts';

import type { Setup } from './analysis.ts';
import type { RungRow } from './row.ts';

const DASH = '—';

const cell = (value: string | number | null): string =>
  value === null || value === ''
    ? DASH
    : String(value)
        .replaceAll('|', '\\|')
        .replaceAll(/\s*\n\s*/g, ' ');

const table = (
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');

const short = (hash: string | null) =>
  hash === null ? null : hash.slice(0, 7);

/** An app version and the commits it was run at: `3f2a1b9 (005f9cc, 1c0e2d4)`. */
const version = (setup: Setup) =>
  `${short(setup.appTree) ?? ''} (${setup.commits.map((c) => short(c) ?? '').join(', ')})`;

const ms = (value: number | null) =>
  value === null ? null : `${Math.round(value).toLocaleString('en-US')} ms`;

const pct = (rate: number | null) =>
  rate === null ? null : `${(rate * 100).toFixed(1)}%`;

const users = (count: number, atLeast: boolean) =>
  `${atLeast ? '≥ ' : ''}${count.toLocaleString('en-US')}`;

const latency = (p95: number | null, p99: number | null) =>
  p95 === null || p99 === null ? null : `${ms(p95) ?? ''} / ${ms(p99) ?? ''}`;

/** Where the app ran, when it was pinned: `dev-server`, or `dev-server (CPUs 0-7)`. */
const where = (host: string, appCpuset: string | null) =>
  appCpuset === null ? host : `${host} (CPUs ${appCpuset})`;

const shedding = (row: RungRow): string =>
  row.load_shed_enabled === false
    ? 'off'
    : `on (lag ${String(row.max_lag_ms)} ms, pool ${String(row.max_pool_waiting)}, retry ${String(row.retry_after_s)} s)`;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const hostsSection = (rows: readonly RungRow[]): string => {
  const latest = new Map<string, RungRow>();

  for (const row of rows) latest.set(row.host ?? '', row);

  return [
    '## Hosts',
    table(
      ['Host', 'CPU', 'Cores', 'RAM', 'Kernel', 'WSL', 'Docker'],
      [...latest.values()]
        .sort((a, b) => byText(a.host ?? '', b.host ?? ''))
        .map((r) => [
          r.host,
          r.cpu_model,
          r.cores,
          r.ram_gib === null ? null : `${String(r.ram_gib)} GiB`,
          r.kernel,
          r.wsl === null ? null : r.wsl ? 'yes' : 'no',
          r.docker_version,
        ]),
    ),
  ].join('\n\n');
};

const capacitySection = (rows: readonly RungRow[]): string => {
  const found = capacities(rows).sort(
    (a, b) =>
      byText(a.harnessTree ?? '', b.harnessTree ?? '') ||
      byText(a.host, b.host) ||
      byText(a.appTree, b.appTree) ||
      byText(a.phase, b.phase),
  );

  if (found.length === 0) {
    return '## Capacity\n\nNo phase has been run with shedding off yet.';
  }

  const harnesses = [...new Set(found.map((c) => c.harnessTree))];
  const parts = [
    '## Capacity',
    'Shedding off, `IP_MODE=spread`. **Capacity** is the highest `SCALE` that passed every run; the **knee** the ' +
      'lowest that failed. **Users** is capacity times the people the phase models at `SCALE=1`. Rows under ' +
      'different harness trees are not comparable, since the scenarios differ, and are kept apart.',
  ];

  for (const harness of harnesses) {
    const group = found.filter((c) => c.harnessTree === harness);

    if (harnesses.length > 1)
      parts.push(`### Harness \`${short(harness) ?? 'unknown'}\``);

    parts.push(
      table(
        ['Host', 'App', 'Phase', 'Capacity', 'Knee', 'Users', 'Rungs', 'Notes'],
        group.map((c) => [
          where(c.host, c.appCpuset),
          version(c),
          c.phase,
          c.capacity,
          c.knee ?? `none up to ${String(c.capacity)}`,
          c.users === null ? null : users(c.users, c.knee === null),
          c.rungs,
          [
            c.unstable ? 'unstable: a repeat disagreed' : '',
            c.settled ? '' : 'search not finished',
          ]
            .filter(Boolean)
            .join('; '),
        ]),
      ),
    );

    const events = headlines(group);

    if (events.length > 0) {
      parts.push(
        table(
          [
            'Host',
            'App',
            'Users',
            `× ${BASELINE_USERS.toLocaleString('en-US')}`,
            'Limited by',
          ],
          events.map((h) => [
            where(h.host, h.appCpuset),
            version(h),
            users(h.users, h.atLeast),
            `${h.atLeast ? '≥ ' : ''}${(h.users / BASELINE_USERS).toFixed(1)}`,
            h.phase,
          ]),
        ),
      );
    }
  }

  return parts.join('\n\n');
};

const configSection = (rows: readonly RungRow[]): string => {
  const results = configurations(rows, capacities(rows)).sort(
    (a, b) =>
      byText(a.host, b.host) ||
      byText(a.appTree, b.appTree) ||
      byText(a.phase, b.phase) ||
      Number(b.best) - Number(a.best),
  );

  const intro =
    'Shedding on, from each knee up. A configuration **meets the target** when every rung from the knee up passed ' +
    'its thresholds. The best meets it with the least shed at the knee; if none does, the closest has the smallest ' +
    'share of failing rungs, then the lowest worst p95.';

  if (results.length === 0) {
    return `## Shedding past the knee\n\n${intro}\n\nNo configuration has been run past a knee yet.`;
  }

  return [
    '## Shedding past the knee',
    intro,
    table(
      [
        'Host',
        'App',
        'Phase',
        'Knee',
        'Configuration',
        'Scales',
        'At',
        'p95 / p99',
        'Shed',
        'Target',
        'Best',
      ],
      results.map((r) => [
        where(r.host, r.appCpuset),
        version(r),
        r.phase,
        r.knee,
        `lag ${String(r.maxLagMs)} ms, pool ${String(r.maxPoolWaiting)}, retry ${String(r.retryAfterS)} s`,
        r.scales.join(', '),
        r.atKnee.scale,
        latency(r.atKnee.p95, r.atKnee.p99),
        pct(r.atKnee.shed),
        r.meets ? 'met' : `missed (${String(r.failing)} of ${String(r.rungs)})`,
        r.best ? (r.meets ? 'best' : 'closest') : '',
      ]),
    ),
  ].join('\n\n');
};

const limiterSection = (rows: readonly RungRow[]): string => {
  const results = limiterRuns(rows).sort(
    (a, b) =>
      byText(a.host, b.host) ||
      byText(a.phase, b.phase) ||
      byText(a.ipMode, b.ipMode) ||
      Number(a.trusted) - Number(b.trusted) ||
      byText(a.overrides ?? '', b.overrides ?? '') ||
      byText(a.k6Env ?? '', b.k6Env ?? '') ||
      a.scale - b.scale ||
      byText(a.lastRun ?? '', b.lastRun ?? ''),
  );

  const intro =
    'Rungs a limiter can bind on: the room behind a shared address (`single`, or `cgnat` with carriers), trusted ' +
    'addresses or overridden quotas. **Refused** is the worst share of requests answered `429` over the runs, and ' +
    '**flow failed** the worst share of people who did not finish. A quota or k6 change is a new line beside the old.';

  if (results.length === 0) {
    return (
      `## Limiter balance\n\n${intro}\n\nNo limiter run recorded yet. Runs 1 to 3 in ` +
      '[`load-testing.md`](./load-testing.md), through the runner, add them.'
    );
  }

  return [
    '## Limiter balance',
    intro,
    table(
      [
        'Host',
        'App',
        'Phase',
        'IP mode',
        'Venue trusted',
        'Overrides',
        'k6 settings',
        'SCALE',
        'Result',
        'Refused',
        'Captchas',
        'Flow failed',
        'Last run',
      ],
      results.map((r) => [
        where(r.host, r.appCpuset),
        version(r),
        r.phase,
        r.ipMode,
        r.trusted ? 'yes' : 'no',
        r.overrides,
        r.k6Env,
        r.scale,
        r.passed === r.runs
          ? 'pass'
          : r.passed === 0
            ? 'fail'
            : `${String(r.passed)} of ${String(r.runs)} passed`,
        pct(r.refused),
        r.captchas,
        pct(r.flowFailed),
        r.lastRun === null ? null : r.lastRun.slice(0, 10),
      ]),
    ),
  ].join('\n\n');
};

const rungsSection = (rows: readonly RungRow[]): string => {
  const sessions = new Map<string, RungRow[]>();

  for (const row of rows) {
    const session = row.session ?? '';

    sessions.set(session, [...(sessions.get(session) ?? []), row]);
  }

  return [
    '## Rungs',
    'Every rung recorded, by session. An invalid rung is kept with its reason and counts towards nothing above.',
    ...[...sessions.entries()]
      .sort(([a], [b]) => byText(a, b))
      .flatMap(([session, group]) => {
        const [first] = group;
        const notes = [...new Set(group.map((r) => r.note).filter(Boolean))];

        return [
          `### ${session}`,
          [
            `${first?.phase ?? ''} on ${where(first?.host ?? '', first?.app_cpuset ?? null)} at \`${short(first?.commit ?? null) ?? ''}\` (app \`${short(first?.app_tree ?? null) ?? ''}\`)` +
              `${first?.dirty === true ? ' (uncommitted changes)' : ''}, shedding ${first ? shedding(first) : ''}.`,
            ...notes.map(
              (note) => `Note: ${(note ?? '').replaceAll(/\s*\n\s*/g, ' ')}`,
            ),
          ].join(' '),
          table(
            [
              'Rung',
              'SCALE',
              'Result',
              'p95 / p99',
              'Shed',
              'Dropped',
              'App CPU',
              'Other load',
              'Validity',
            ],
            group.map((r) => [
              r.rung,
              r.scale,
              r.thresholds_passed === null
                ? null
                : r.thresholds_passed
                  ? 'pass'
                  : 'fail',
              latency(r.served_p95, r.served_p99),
              pct(r.shed_rate),
              pct(r.dropped_rate),
              r.app_cpu_peak === null
                ? null
                : `${Math.round(r.app_cpu_peak).toString()}%`,
              r.other_load_p95 === null
                ? null
                : `${r.other_load_p95.toFixed(2)} cores`,
              r.valid === false
                ? `invalid: ${r.invalid_reason ?? ''}`
                : 'valid',
            ]),
          ),
        ];
      }),
  ].join('\n\n');
};

/**
 * The whole document.
 *
 * @param rows - Every recorded rung, from every session file.
 */
export const renderReport = (rows: readonly RungRow[]): string => {
  const head = [
    '# Load-test results',
    'Generated by `npm run loadtest:report` from `loadtest/history/`. Do not edit by hand.',
    "Commit SHAs here and in the session file names refer to the private archive repository, not to this repository's history.",
    'Method, definitions and validity rules: [How a session is recorded and judged](./load-testing.md#how-a-session-is-recorded-and-judged). ' +
      `Estimates are stated against a baseline of ${BASELINE_USERS.toLocaleString('en-US')} users. ` +
      'Capacity is server capacity, not venue capacity: no limiter binds on those rungs. **Limiter balance** is ' +
      'what a room behind a shared address gets through.',
  ];

  if (rows.length === 0) {
    return `${[
      ...head,
      'No sessions recorded yet. Run `node scripts/loadtest/ladder.ts`; ' +
        '[`load-testing.md`](./load-testing.md) has the setup.',
    ].join('\n\n')}\n`;
  }

  return `${[
    ...head,
    hostsSection(rows),
    capacitySection(rows),
    configSection(rows),
    limiterSection(rows),
    rungsSection(rows),
  ].join('\n\n')}\n`;
};
