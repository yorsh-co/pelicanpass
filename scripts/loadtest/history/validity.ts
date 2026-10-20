/**
 * Whether a rung's numbers can be trusted, and if not, why.
 *
 * An invalid rung stays in its session file with the reason, so a comparison
 * can show what was discarded rather than silently lose it.
 */

import type { RungRow } from './row.ts';

export interface Limits {
  /** Host CPU not spent by the stack, in cores (p95 over the rung). */
  otherLoadCores: number;
  /** Package throttling during the rung, in milliseconds. */
  throttleMs: number;
  /** Share of arrivals k6 dropped, above which a pass is not a pass. */
  droppedRate: number;
}

export const DEFAULT_LIMITS: Limits = {
  otherLoadCores: 1,
  throttleMs: 1_000,
  droppedRate: 0.01,
};

/** k6's exit code when thresholds failed and nothing else went wrong. */
const THRESHOLDS_FAILED = 99;

/**
 * Judges a rung.
 *
 * A column left empty (a backfilled session, or a host without the throttle
 * counter) is not held against it.
 *
 * **Dropped arrivals invalidate a pass, not a fail.** A rung that failed while
 * k6 was dropping arrivals failed on less load than intended, so the knee is
 * at or below it either way.
 *
 * @param row - The rung, before its verdict.
 * @param limits - Thresholds; {@link DEFAULT_LIMITS} unless overridden.
 * @returns `valid`, and every reason it is not, joined.
 */
export const judge = (
  row: Omit<RungRow, 'valid' | 'invalid_reason'>,
  limits: Limits = DEFAULT_LIMITS,
): Pick<RungRow, 'valid' | 'invalid_reason'> => {
  const reasons: string[] = [];

  if (
    row.k6_exit !== null &&
    row.k6_exit !== 0 &&
    row.k6_exit !== THRESHOLDS_FAILED
  ) {
    reasons.push(`k6 exited ${String(row.k6_exit)}`);
  }

  if (
    row.other_load_p95 !== null &&
    row.other_load_p95 > limits.otherLoadCores
  ) {
    const top = row.other_top === null ? '' : `: ${row.other_top}`;

    reasons.push(
      `host busy (${row.other_load_p95.toFixed(1)} cores of other load${top})`,
    );
  }

  if (row.throttle_ms !== null && row.throttle_ms > limits.throttleMs) {
    reasons.push(`host throttled (${String(row.throttle_ms)} ms)`);
  }

  if (
    row.thresholds_passed === true &&
    row.dropped_rate !== null &&
    row.dropped_rate > limits.droppedRate
  ) {
    reasons.push(`dropped ${(row.dropped_rate * 100).toFixed(1)}% of arrivals`);
  }

  return {
    valid: reasons.length === 0,
    invalid_reason: reasons.length > 0 ? reasons.join('; ') : null,
  };
};
