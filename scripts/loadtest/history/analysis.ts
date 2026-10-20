/**
 * Reduces recorded rungs to what the report compares: each phase's capacity
 * and knee per host and commit, the users that carries, the shedding
 * configuration that serves best past the knee, and what the limiters refuse
 * under a shared address.
 *
 * Method and definitions: docs/performance/load-testing.md, "How a session is recorded
 * and judged".
 */

import { kneeBoundary, nextKneeStep } from './knee.ts';

import type { RungRow } from './row.ts';

/** The event size estimates are stated against. */
export const BASELINE_USERS = 1_000;

/**
 * People each phase models at `SCALE=1`, from the event brief in
 * loadtest/run.ts. Redemptions scale counters, not people, and have none.
 */
export const PHASE_POPULATION: Readonly<Record<string, number>> = {
  'checkin-volunteers': 200,
  'checkin-participants': 500,
  raffle: 500,
  survey: 500,
};

/** What makes two rungs comparable, beyond their configuration. */
export interface Setup {
  host: string;
  cpuModel: string | null;
  /** What the image was built from (`code.ts`); the commit, for a row without one. */
  appTree: string;
  /** Every commit the rungs ran at: a docs-only commit leaves `appTree` alone. */
  commits: string[];
  harnessTree: string | null;
  appCpuset: string | null;
}

export interface Capacity extends Setup {
  /** Groups rungs that compare as one: setup and phase. */
  key: string;
  phase: string;
  /** Highest `SCALE` that passed every run; 0 if even 1 failed. */
  capacity: number;
  /** Lowest `SCALE` that failed; `null` if none did. */
  knee: number | null;
  unstable: boolean;
  /** Whether the search finished; a `--scales` sweep may not have. */
  settled: boolean;
  rungs: number;
  /** Capacity times the phase's population; `null` without a population. */
  users: number | null;
}

export interface Headline extends Setup {
  /** The phase with the fewest estimated users. */
  phase: string;
  users: number;
  /** The limiting phase found no knee, so the estimate is a lower bound. */
  atLeast: boolean;
}

export interface ConfigResult extends Setup {
  key: string;
  phase: string;
  knee: number;
  maxLagMs: number | null;
  maxPoolWaiting: number | null;
  retryAfterS: number | null;
  /** Every valid rung from the knee up passed its thresholds. */
  meets: boolean;
  rungs: number;
  scales: number[];
  /** Mean over the runs at the lowest `SCALE` tried from the knee up. */
  atKnee: { scale: number; p95: number; p99: number; shed: number };
  failing: number;
  worstP95: number | null;
  best: boolean;
}

export interface LimiterResult extends Setup {
  phase: string;
  ipMode: string;
  trusted: boolean;
  /** `RATE_LIMIT_OVERRIDES` as the app ran with it; see {@link overridesOf}. */
  overrides: string | null;
  /** The k6 settings changed from their defaults, as `ladder.ts` records them. */
  k6Env: string | null;
  scale: number;
  runs: number;
  passed: number;
  /** Worst share of requests refused with a `429` over the runs. */
  refused: number | null;
  /** Most captchas one run hit. */
  captchas: number | null;
  /** Worst share of flows that did not finish. */
  flowFailed: number | null;
  /** When the latest run started. */
  lastRun: string | null;
}

const appTreeOf = (row: RungRow): string => row.app_tree ?? row.commit ?? '';

/**
 * The overrides a rung ran with. A schema 1 or 2 row records only that some
 * were set, not which.
 *
 * @param row - The rung.
 */
const overridesOf = (row: RungRow): string | null =>
  row.rate_limit_overrides ??
  (row.overrides_set === true ? 'set, value not recorded' : null);

const commitsOf = (rows: readonly RungRow[]): string[] =>
  [...new Set(rows.flatMap((r) => (r.commit ? [r.commit] : [])))].sort();

/**
 * The setup a group of rungs shares.
 *
 * @param group - Rungs with the same host, app, harness and pinning.
 */
const setupOf = (group: readonly [RungRow, ...RungRow[]]): Setup => {
  const [first] = group;

  return {
    host: first.host ?? '',
    cpuModel: first.cpu_model,
    appTree: appTreeOf(first),
    commits: commitsOf(group),
    harnessTree: first.harness_tree,
    appCpuset: first.app_cpuset,
  };
};

const keyOf = (row: RungRow, ...extra: unknown[]): string =>
  JSON.stringify([
    row.host,
    appTreeOf(row),
    row.harness_tree,
    row.app_cpuset,
    row.phase,
    ...extra,
  ]);

/**
 * A valid rung with its outcome, on the spread addresses no limiter binds and
 * the scenarios' default load.
 */
const usable = (row: RungRow): boolean =>
  row.valid === true &&
  row.thresholds_passed !== null &&
  row.scale !== null &&
  row.ip_mode === 'spread' &&
  row.trusted_ips_set !== true &&
  row.overrides_set !== true &&
  row.k6_env === null;

const groupBy = <T>(items: readonly T[], key: (item: T) => string) => {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }

  return [...groups.values()];
};

const mean = (values: readonly number[]): number =>
  values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Each phase's capacity and knee, from the rungs run with shedding off.
 *
 * @param rows - Every recorded rung, valid or not.
 */
export const capacities = (rows: readonly RungRow[]): Capacity[] =>
  groupBy(
    rows.filter((r) => usable(r) && r.load_shed_enabled === false),
    (r) => keyOf(r),
  ).flatMap((group) => {
    const [first, ...rest] = group;

    if (!first) return [];

    const outcomes = group.map((r) => ({
      scale: r.scale ?? 0,
      passed: r.thresholds_passed === true,
    }));
    const { capacity, knee, unstable } = kneeBoundary(outcomes);
    const phase = first.phase ?? '';
    const population = PHASE_POPULATION[phase];

    return [
      {
        ...setupOf([first, ...rest]),
        key: keyOf(first),
        phase,
        capacity,
        knee,
        unstable,
        settled: nextKneeStep(outcomes).done,
        rungs: group.length,
        users: population === undefined ? null : capacity * population,
      },
    ];
  });

/**
 * The event-wide estimate per host and app version: the phase that carries
 * the fewest users sets it.
 *
 * @param found - From {@link capacities}.
 */
export const headlines = (found: readonly Capacity[]): Headline[] =>
  groupBy(
    found.filter((c) => c.users !== null),
    (c) => JSON.stringify([c.host, c.appTree, c.harnessTree, c.appCpuset]),
  ).flatMap((group) => {
    const limiting = [...group].sort(
      (a, b) => (a.users ?? 0) - (b.users ?? 0),
    )[0];

    if (!limiting) return [];

    const { phase, users, knee } = limiting;

    return [
      {
        host: limiting.host,
        cpuModel: limiting.cpuModel,
        appTree: limiting.appTree,
        commits: [...new Set(group.flatMap((c) => c.commits))].sort(),
        harnessTree: limiting.harnessTree,
        appCpuset: limiting.appCpuset,
        phase,
        users: users ?? 0,
        atLeast: knee === null,
      },
    ];
  });

/**
 * Every shedding configuration tried from a phase's knee up, ranked: those
 * meeting the target first, by the least shed at the knee; then the rest, by
 * the smallest share of failing rungs and the lowest worst p95. The first is
 * the best.
 *
 * @param rows - Every recorded rung, valid or not.
 * @param found - From {@link capacities}: a phase without a knee has nothing
 *   to test past, and is left out.
 */
export const configurations = (
  rows: readonly RungRow[],
  found: readonly Capacity[],
): ConfigResult[] => {
  const knees = new Map(
    found.flatMap((c) => (c.knee === null ? [] : [[c.key, c.knee] as const])),
  );

  const kneeOf = (row: RungRow) => knees.get(keyOf(row));

  const results = groupBy(
    rows.filter((r) => {
      const knee = kneeOf(r);

      return (
        usable(r) &&
        r.load_shed_enabled === true &&
        knee !== undefined &&
        (r.scale ?? 0) >= knee
      );
    }),
    (r) => keyOf(r, r.max_lag_ms, r.max_pool_waiting, r.retry_after_s),
  ).flatMap((group): ConfigResult[] => {
    const [first, ...rest] = group;
    const knee = first ? kneeOf(first) : undefined;

    if (!first || knee === undefined) return [];

    const lowest = Math.min(...group.map((r) => r.scale ?? Infinity));
    const atLowest = group.filter((r) => r.scale === lowest);
    const p95s = group.flatMap((r) =>
      r.served_p95 === null ? [] : [r.served_p95],
    );

    return [
      {
        ...setupOf([first, ...rest]),
        key: keyOf(first),
        phase: first.phase ?? '',
        knee,
        maxLagMs: first.max_lag_ms,
        maxPoolWaiting: first.max_pool_waiting,
        retryAfterS: first.retry_after_s,
        meets: group.every((r) => r.thresholds_passed === true),
        rungs: group.length,
        scales: [...new Set(group.map((r) => r.scale ?? 0))].sort(
          (a, b) => a - b,
        ),
        atKnee: {
          scale: lowest,
          p95: mean(atLowest.map((r) => r.served_p95 ?? 0)),
          p99: mean(atLowest.map((r) => r.served_p99 ?? 0)),
          shed: mean(atLowest.map((r) => r.shed_rate ?? 0)),
        },
        failing: group.filter((r) => r.thresholds_passed !== true).length,
        worstP95: p95s.length > 0 ? Math.max(...p95s) : null,
        best: false,
      },
    ];
  });

  return groupBy(results, (r) => r.key).flatMap((group) => {
    const ranked = [...group].sort(
      (a, b) =>
        Number(b.meets) - Number(a.meets) ||
        (a.meets
          ? a.atKnee.shed - b.atKnee.shed
          : a.failing / a.rungs - b.failing / b.rungs ||
            (a.worstP95 ?? Infinity) - (b.worstP95 ?? Infinity)),
    );

    return ranked.map((result, i) => ({ ...result, best: i === 0 }));
  });
};

const worst = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);

  return known.length > 0 ? Math.max(...known) : null;
};

/**
 * Every configuration a limiter can bind under, per `SCALE`: a shared address
 * (`single` or `cgnat`), trusted addresses or overridden quotas, with the k6
 * settings they ran with. A quota or k6 change is a new line beside the old
 * one, which is how a change is compared over time.
 *
 * @param rows - Every recorded rung, valid or not.
 */
export const limiterRuns = (rows: readonly RungRow[]): LimiterResult[] =>
  groupBy(
    rows.filter(
      (r) =>
        r.valid === true &&
        r.thresholds_passed !== null &&
        r.scale !== null &&
        (r.ip_mode !== 'spread' ||
          r.trusted_ips_set === true ||
          r.overrides_set === true),
    ),
    (r) =>
      keyOf(
        r,
        r.ip_mode,
        r.trusted_ips_set === true,
        overridesOf(r),
        r.k6_env,
        r.scale,
      ),
  ).flatMap((group): LimiterResult[] => {
    const [first, ...rest] = group;

    if (!first) return [];

    const started = group.flatMap((r) =>
      r.started_at === null ? [] : [r.started_at],
    );

    return [
      {
        ...setupOf([first, ...rest]),
        phase: first.phase ?? '',
        ipMode: first.ip_mode ?? '',
        trusted: first.trusted_ips_set === true,
        overrides: overridesOf(first),
        k6Env: first.k6_env,
        scale: first.scale ?? 0,
        runs: group.length,
        passed: group.filter((r) => r.thresholds_passed === true).length,
        refused: worst(group.map((r) => r.rate_limited_rate)),
        captchas: worst(group.map((r) => r.captcha)),
        flowFailed: worst(group.map((r) => r.flow_failed_rate)),
        lastRun: started.length > 0 ? (started.sort().at(-1) ?? null) : null,
      },
    ];
  });
