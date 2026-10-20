import pg from '../db/postgres.ts';
import { checkRedis } from '../db/redis.ts';

/**
 * Result of one dependency probe.
 */
export interface ProbeResult {
  readonly ok: boolean;
  /** Round-trip in milliseconds, whether or not the probe succeeded. */
  readonly durationMs: number;
  /** Failure reason, safe to log. Absent when `ok`. */
  readonly error?: string;
}

const timed = async (run: () => Promise<unknown>): Promise<ProbeResult> => {
  const started = Date.now();

  try {
    await run();

    return { ok: true, durationMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Pings Redis.
 *
 * Wraps `checkRedis`, which was kept for exactly this caller: a readiness
 * signal shared by `/readyz` and the alert rules.
 *
 * `commandTimeout: 1000` on the client bounds how long this can take, so the
 * evaluation loop cannot be wedged by a hung ping.
 */
export const probeRedis = (): Promise<ProbeResult> => timed(() => checkRedis());

/**
 * Runs the cheapest possible query against Postgres.
 *
 * The pool sets `query_timeout: 5_000`, which bounds this the same way.
 */
export const probePostgres = (): Promise<ProbeResult> =>
  timed(() => pg.query('SELECT 1'));

/** Both dependencies, as one reading. */
export interface DependencyReport {
  redis: ProbeResult;
  postgres: ProbeResult;
}

/**
 * How long one reading is reused.
 *
 * **This has to stay far below the alert loop's 30-second tick.** That loop
 * counts consecutive failures and pages on the second one, so a TTL approaching
 * its interval would let two ticks read a single cached failure and raise a
 * critical off one probe. A second is two orders of magnitude clear of it.
 */
const CACHE_MS = 1_000;

let cached: { at: number; report: Promise<DependencyReport> } | null = null;

/**
 * Both probes, run concurrently — and at most once per {@link CACHE_MS}.
 *
 * Shared by `/readyz` and the alert rules so the endpoint and the alert cannot
 * disagree about what "ready" means — two implementations would drift, and the
 * drift would show up as a green endpoint beside a red alert at the worst
 * possible moment. Caching strengthens that rather than weakening it: the two
 * now frequently read the identical measurement.
 *
 * **The cache is what bounds abuse of `/readyz`, and a rate limiter could not
 * do it.** That endpoint takes no session and is deliberately mounted above the
 * routers so a probe is not charged against `ipLimiter`; the cost worth
 * protecting is the Redis `PING` and the Postgres `SELECT 1` behind it. A
 * Redis-backed limiter would have replaced the ping with its own round trip and
 * saved nothing. This caps the real cost at one reading per second no matter how
 * many requests arrive, and refuses nobody — which matters for an endpoint whose
 * entire purpose is to answer while things are broken.
 *
 * The promise is cached rather than the value, so concurrent callers share one
 * in-flight probe instead of starting a stampede of their own.
 */
export const probeDependencies = (): Promise<DependencyReport> => {
  const now = Date.now();

  if (cached && now - cached.at < CACHE_MS) return cached.report;

  const report = Promise.all([probeRedis(), probePostgres()]).then(
    ([redis, postgres]) => ({ redis, postgres }),
  );

  cached = { at: now, report };

  // A rejected probe must not be served for the rest of the window. `timed`
  // already converts failure into an `ok: false` result rather than a rejection,
  // so this is a backstop against a future edit rather than a live path.
  report.catch(() => {
    cached = null;
  });

  return report;
};
