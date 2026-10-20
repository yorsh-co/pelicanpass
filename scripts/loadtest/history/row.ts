/**
 * One CSV row per k6 rung: its columns, and the mapping from a k6 summary
 * export to the results they record.
 *
 * Method and definitions: docs/performance/load-testing.md, "How a session is recorded
 * and judged".
 */

/** Bumped whenever a column is added, removed or changes meaning. */
export const SCHEMA = 3;

type Kind = 'string' | 'number' | 'boolean';

/**
 * Every column in file order, with the type its cells hold. A cell may also be
 * empty (`null`): not recorded, as in a session backfilled from before the
 * column existed.
 */
export const COLUMN_KINDS = {
  schema: 'number',

  session: 'string',
  rung: 'string',
  started_at: 'string',
  note: 'string',

  host: 'string',
  cpu_model: 'string',
  cores: 'number',
  ram_gib: 'number',
  kernel: 'string',
  wsl: 'boolean',
  docker_version: 'string',
  app_cpuset: 'string',

  commit: 'string',
  describe: 'string',
  branch: 'string',
  dirty: 'boolean',
  app_tree: 'string',
  harness_tree: 'string',

  load_shed_enabled: 'boolean',
  max_lag_ms: 'number',
  max_pool_waiting: 'number',
  retry_after_s: 'number',
  trusted_ips_set: 'boolean',
  overrides_set: 'boolean',
  rate_limit_overrides: 'string',

  phase: 'string',
  scale: 'number',
  ip_mode: 'string',
  k6_env: 'string',
  roster_participants: 'number',

  k6_exit: 'number',
  thresholds_passed: 'boolean',
  served_p95: 'number',
  served_p99: 'number',
  served_max: 'number',
  phase_trend_p95: 'number',
  shed_rate: 'number',
  flow_shed_rate: 'number',
  flow_failed_rate: 'number',
  server_error_rate: 'number',
  rate_limited_rate: 'number',
  captcha: 'number',
  reqs: 'number',
  iterations: 'number',
  dropped: 'number',
  dropped_rate: 'number',

  app_cpu_p95: 'number',
  app_cpu_peak: 'number',
  db_cpu_peak: 'number',
  k6_cpu_peak: 'number',
  host_cpu_peak: 'number',
  other_load_p95: 'number',
  other_top: 'string',
  throttle_ms: 'number',
  load1_peak: 'number',
  pg_active_peak: 'number',
  shed_starts: 'number',
  pool_waiting_at_start_max: 'number',
  lag_at_start_max: 'number',

  valid: 'boolean',
  invalid_reason: 'string',
} as const satisfies Record<string, Kind>;

export type Column = keyof typeof COLUMN_KINDS;

type CellOf<K extends Kind> = K extends 'number'
  ? number
  : K extends 'boolean'
    ? boolean
    : string;

export type RungRow = {
  [C in Column]: CellOf<(typeof COLUMN_KINDS)[C]> | null;
};

export const COLUMNS = Object.keys(COLUMN_KINDS) as Column[];

/**
 * Columns added since schema 1. A file written before one existed lacks it,
 * and reads with the column empty rather than being refused.
 */
export const LATER_COLUMNS: readonly Column[] = [
  'rate_limit_overrides',
  'k6_env',
];

export type ResultColumns = Pick<
  RungRow,
  | 'k6_exit'
  | 'thresholds_passed'
  | 'served_p95'
  | 'served_p99'
  | 'served_max'
  | 'phase_trend_p95'
  | 'shed_rate'
  | 'flow_shed_rate'
  | 'flow_failed_rate'
  | 'server_error_rate'
  | 'rate_limited_rate'
  | 'captcha'
  | 'reqs'
  | 'iterations'
  | 'dropped'
  | 'dropped_rate'
>;

/**
 * The trend each phase gates on, beside `served_duration`. Mirrors
 * `PHASE_TREND` in loadtest/run.ts, which compiles against k6's types and
 * cannot be imported here.
 */
const PHASE_TREND: Readonly<Record<string, string>> = {
  'checkin-volunteers': 'checkin_complete_duration',
  'checkin-participants': 'checkin_complete_duration',
  survey: 'survey_submit_duration',
};

type Metrics = Record<string, unknown>;

/** Narrows parsed JSON to a plain object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Takes the `metrics` object out of a parsed `--summary-export` file.
 *
 * Only `metrics` is read. The export also carries `setup_data`, which holds the
 * attendee sessions `setup()` minted, and none of it may reach a committed row.
 *
 * @param summary - The parsed export.
 * @throws {Error} If it has no `metrics` object.
 */
export const summaryMetrics = (summary: unknown): Metrics => {
  if (!isRecord(summary) || !isRecord(summary.metrics)) {
    throw new Error('Not a k6 summary export: no "metrics" object');
  }

  return summary.metrics;
};

/**
 * Reads one statistic of one metric, or `null` if either is absent. k6 leaves a
 * metric out of the export when nothing recorded it.
 *
 * @param metrics - From {@link summaryMetrics}.
 * @param metric - Metric name, e.g. `served_duration`.
 * @param key - Statistic, e.g. `p(95)`, `value` (a rate) or `count`.
 */
const stat = (metrics: Metrics, metric: string, key: string): number | null => {
  const entry = metrics[metric];

  if (!isRecord(entry)) return null;

  const value = entry[key];

  return typeof value === 'number' ? value : null;
};

/**
 * Whether every threshold passed. In the export a threshold maps to `true`
 * when it **failed**.
 *
 * @param metrics - From {@link summaryMetrics}.
 */
const thresholdsPassed = (metrics: Metrics): boolean =>
  Object.values(metrics).every(
    (entry) =>
      !isRecord(entry) ||
      !isRecord(entry.thresholds) ||
      Object.values(entry.thresholds).every((failed) => failed !== true),
  );

/**
 * Maps a k6 summary export to the result columns of its rung.
 *
 * Rates are fractions (0.25, not 25%). `dropped_rate` is dropped arrivals over
 * all arrivals: k6 counts an arrival it had no VU for as a dropped iteration,
 * not an iteration.
 *
 * @param summary - The parsed `--summary-export` file.
 * @param phase - The rung's `PHASE`, which picks its own trend.
 * @param k6Exit - k6's exit code: 0, or 99 when only thresholds failed.
 */
export const resultsFromSummary = (
  summary: unknown,
  phase: string,
  k6Exit: number,
): ResultColumns => {
  const metrics = summaryMetrics(summary);
  const trend = PHASE_TREND[phase];

  const iterations = stat(metrics, 'iterations', 'count') ?? 0;
  const dropped = stat(metrics, 'dropped_iterations', 'count') ?? 0;
  const arrivals = iterations + dropped;

  return {
    k6_exit: k6Exit,
    thresholds_passed: thresholdsPassed(metrics),
    served_p95: stat(metrics, 'served_duration', 'p(95)'),
    served_p99: stat(metrics, 'served_duration', 'p(99)'),
    served_max: stat(metrics, 'served_duration', 'max'),
    phase_trend_p95: trend ? stat(metrics, trend, 'p(95)') : null,
    shed_rate: stat(metrics, 'shed', 'value'),
    flow_shed_rate: stat(metrics, 'flow_shed', 'value'),
    flow_failed_rate: stat(metrics, 'flow_failed', 'value'),
    server_error_rate: stat(metrics, 'server_errors', 'value'),
    rate_limited_rate: stat(metrics, 'rate_limited', 'value'),
    captcha: stat(metrics, 'captcha_required', 'count'),
    reqs: stat(metrics, 'http_reqs', 'count'),
    iterations,
    dropped,
    dropped_rate: arrivals > 0 ? dropped / arrivals : 0,
  };
};
