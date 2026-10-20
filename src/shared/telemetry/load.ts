import { monitorEventLoopDelay } from 'node:perf_hooks';

import { env } from '../../config/env.ts';
import pg from '../db/postgres.ts';
import { logger } from '../logger/logger.ts';
import {
  INITIAL_LOAD_STATE,
  isLagging,
  nextLoadState,
  shouldShed as policyShouldShed,
} from './load.policy.ts';
import { recordEvent } from './record.ts';

import type { LoadState } from './load.policy.ts';

/** How often the two signals are read. */
const SAMPLE_INTERVAL_MS = 500;

/**
 * Granularity of the event-loop histogram, in milliseconds.
 *
 * The histogram records how late each of its own timers fired, which includes
 * the resolution itself, so it is subtracted back out of every reading.
 */
const RESOLUTION_MS = 20;

/** Decides lag shedding: on after a second of lag, off after five without. */
let lagState: LoadState = INITIAL_LOAD_STATE;

/**
 * Decides only when to report shedding as started or stopped. Queue shedding
 * has no flag to flip, and reporting each refusal would flap with the queue.
 */
let reportState: LoadState = INITIAL_LOAD_STATE;

/** Refusals since the last tick, fed by {@link noteShed}. */
let shedsThisTick = 0;

let sampleTimer: NodeJS.Timeout | null = null;

/**
 * Whether to refuse the public request in hand.
 *
 * Two reads, no measurement: the lag flag the sampler maintains, and the pool
 * queue's length, an array length in `pg-pool`. False while the sampler is not
 * running, which is what `LOAD_SHED_ENABLED=false` means.
 */
export const shouldShed = (): boolean =>
  sampleTimer !== null &&
  policyShouldShed(
    lagState.overloaded,
    pg.waitingCount,
    env.loadShed.maxPoolWaiting,
  );

/** Counts one refusal towards the sampler's report. */
export const noteShed = (): void => {
  shedsThisTick += 1;
};

/**
 * Starts sampling event-loop lag and the Postgres pool queue.
 *
 * The p99 over the window is used, not the mean. The histogram takes one sample
 * per timer tick and a blocked loop ticks less, so a 150 ms stall is a single
 * sample among several near zero and the mean reports a fraction of it — it
 * under-reads saturation by construction. The p99 is in effect the worst stall
 * in the window; the two-sample rule in `load.policy.ts` is what keeps a single
 * garbage-collection pause from counting as overload.
 *
 * Logged and recorded on the reporting machine's transitions only: a tick with
 * lag over the limit or any refusal counts as bad, under the same start and
 * stop rule as lag shedding. Under overload the logger is one of the things
 * competing for the event loop, so a line per sample, or per refusal, would
 * feed the condition it reports.
 *
 * @returns A function that stops the sampler, for the shutdown path.
 */
export const startLoadMonitor = (): (() => void) => {
  if (!env.loadShed.enabled) {
    logger.info('Load shedding disabled: LOAD_SHED_ENABLED is false');

    return () => undefined;
  }

  if (sampleTimer) return () => undefined;

  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });

  histogram.enable();

  sampleTimer = setInterval(() => {
    const lagMs = Math.max(0, histogram.percentile(99) / 1e6 - RESOLUTION_MS);
    const poolWaiting = pg.waitingCount;
    const sheds = shedsThisTick;

    histogram.reset();
    shedsThisTick = 0;

    const lagging = isLagging(lagMs, env.loadShed.maxLagMs);

    lagState = nextLoadState(lagState, lagging);

    const next = nextLoadState(reportState, lagging || sheds > 0);

    reportState = next;

    if (!next.changed) return;

    // `Load shedding started` with `lagMs` and `poolWaiting` is parsed by the
    // load-test harness (scripts/loadtest/history/samples.ts).
    const fields = { lagMs: Math.round(lagMs), poolWaiting, sheds };

    if (next.overloaded) {
      logger.warn(fields, 'Load shedding started');
    } else {
      logger.info(fields, 'Load shedding stopped');
    }

    recordEvent({
      severity: next.overloaded ? 'warn' : 'info',
      kind: 'domain',
      code: next.overloaded ? 'LOAD_SHED_ON' : 'LOAD_SHED_OFF',
      message: next.overloaded
        ? 'Load shedding started'
        : 'Load shedding stopped',
    });
  }, SAMPLE_INTERVAL_MS);

  sampleTimer.unref();

  return () => {
    if (sampleTimer) clearInterval(sampleTimer);
    sampleTimer = null;
    histogram.disable();
    lagState = INITIAL_LOAD_STATE;
    reportState = INITIAL_LOAD_STATE;
    shedsThisTick = 0;
  };
};
